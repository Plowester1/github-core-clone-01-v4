import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';

import { isoOf, Store } from './store.ts';
import type { User, Repo } from './store.ts';
import {
  advertiseV0,
  advertiseV2,
  decodePktLines,
  encodePktLine,
  fetchResponse,
  lsRefsV2,
  parseFetchRequest,
  parseLsRefsRequest,
  parsePushRequest,
  pktFlush,
  receivePack,
} from './git.ts';
import type { GitService } from './git.ts';
import { getRepo, handleRest } from './rest.ts';
import type { RestArgs } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import type { GraphQLArgs } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import type { McpArgs } from './mcp.ts';

const VIEWER_LOGIN = 'adaiversen';

export interface RunningServer {
  server: Server;
  port: number;
}

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function bearerOf(req: { headers: Record<string, string | undefined> }): string {
  const h = req.headers['authorization'] ?? '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  if (h.startsWith('bearer ')) return h.slice(7);
  return '';
}

function tokenOk(token: string): boolean {
  const expected = expectedToken();
  if (expected === '') return true;
  return token === expected;
}

function currentViewerToken(): string {
  return expectedToken();
}

let requestIdCounter = 0;

function nextRequestId(): string {
  requestIdCounter += 1;
  return String(requestIdCounter);
}

async function readBody(req: { headers: Record<string, string | undefined> }, res: {
  emit: (ev: string, err: Error) => boolean;
}): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buf);
    total += buf.length;
  }
  return Buffer.concat(chunks, total);
}

function sendJson(res: {
  writeHead: (code: number, headers: Record<string, string | number>) => void;
  end: (data: string) => void;
}, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  const headers: Record<string, string | number> = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

function sendBuffer(res: {
  writeHead: (code: number, headers: Record<string, string | number>) => void;
  end: (data: Buffer | string) => void;
}, status: number, body: Buffer, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string | number> = {
    'content-length': body.length,
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

function pathSegments(url: string): string[] {
  const u = url.split('?')[0] ?? '';
  return u.split('/').filter((s) => s !== '' && s !== '.' && s !== '..');
}

async function handleGit(
  store: Store,
  segs: string[],
  method: string,
  url: string,
  req: { headers: Record<string, string | undefined>; url?: string },
  res: { writeHead: (code: number, headers: Record<string, string | number>) => void; end: (data: Buffer | string) => void },
  service: GitService,
): Promise<void> {
  const baseSegs = segs.map((s) => (s.endsWith('.git') ? s.slice(0, -4) : s));
  const owner = baseSegs[0] ?? '';
  const name = baseSegs[1] ?? '';
  const repo = store.getRepo(`${owner}/${name}`);
  const operation = segs[2] === 'info' && segs[3] === 'refs'
    ? 'info/refs'
    : (segs[2] ?? '');
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (operation === 'info/refs') {
    const q = new URL(req.url ?? url, 'http://x').searchParams;
    const serviceParam = q.get('service');
    const gitProtocol = req.headers['git-protocol'] ?? '';
    let advertised: Buffer;
    if (serviceParam === 'git-upload-pack' && gitProtocol === 'version=2') {
      advertised = advertiseV2(repo, 'git-upload-pack');
    } else if (serviceParam === 'git-upload-pack') {
      advertised = advertiseV0(repo, 'git-upload-pack');
    } else if (serviceParam === 'git-receive-pack') {
      advertised = advertiseV0(repo, 'git-receive-pack');
    } else {
      advertised = advertiseV0(repo, 'git-upload-pack');
    }
    const headers: Record<string, string | number> = {
      'content-type': `application/x-${serviceParam ?? 'git-upload-pack'}-advertisement`,
      'content-length': advertised.length,
      'cache-control': 'no-cache',
    };
    res.writeHead(200, headers);
    res.end(advertised);
    return;
  }
  if (operation === 'git-upload-pack') {
    const body = await readBody(req as never, res as never);
    const packets = decodePktLines(body);
    const hasLsRefs = packets.some(
      (packet) => packet.kind === 'data' && packet.payload.toString('utf8').replace(/\n$/, '') === 'command=ls-refs',
    );
    const resp = hasLsRefs
      ? lsRefsV2(repo, parseLsRefsRequest(packets))
      : fetchResponse(repo, parseFetchRequest(packets));
    const headers: Record<string, string | number> = {
      'content-type': `application/x-git-upload-pack-result`,
      'content-length': resp.length,
    };
    res.writeHead(200, headers);
    res.end(resp);
    return;
  }
  if (operation === 'git-receive-pack') {
    const body = await readBody(req as never, res as never);
    const { commands, packStart } = parsePushRequest(body);
    const report = receivePack(repo, commands, body.subarray(packStart));
    const reportBytes = encodePushReport(report);
    const framed = sidebandBand1(reportBytes);
    const headers: Record<string, string | number> = {
      'content-type': `application/x-git-receive-pack-result`,
      'content-length': framed.length,
    };
    res.writeHead(200, headers);
    res.end(framed);
    return;
  }
  if (operation === 'git-upload-pack' || operation === 'info/refs') {
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

/** Frame a receive-pack report-status into band-1 sideband packets. */
function sidebandBand1(report: Buffer): Buffer {
  const max = 65515;
  const parts: Buffer[] = [];
  for (let offset = 0; offset < report.length; offset += max) {
    const chunk = report.subarray(offset, Math.min(offset + max, report.length));
    const payload = Buffer.allocUnsafe(1 + chunk.length);
    payload[0] = 1;
    chunk.copy(payload, 1);
    parts.push(encodePktLine(payload));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Build the receive-pack report-status stream from a PushReport. */
function encodePushReport(report: { unpackOk: boolean; unpackDetail: string; refs: ReadonlyArray<{ ref: string; ok: boolean; reason: string }> }): Buffer {
  const lines: Buffer[] = [];
  lines.push(encodePktLine(report.unpackOk ? 'unpack ok\n' : `unpack ${report.unpackDetail}\n`));
  for (const ref of report.refs) {
    if (ref.ok) lines.push(encodePktLine(`ok ${ref.ref}\n`));
    else lines.push(encodePktLine(`ng ${ref.ref} ${ref.reason}\n`));
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

function methodOf(req: { method?: string }): string {
  return (req.method ?? 'GET').toUpperCase();
}

async function dispatch(
  req: { headers: Record<string, string | undefined>; url?: string; method?: string },
  res: { writeHead: (code: number, headers: Record<string, string | number>) => void; end: (data: Buffer | string) => void },
  store: Store,
): Promise<void> {
  const method = methodOf(req);
  const url = req.url ?? '/';
  const segs = pathSegments(urlFormat(url));
  const token = bearerOf(req);

  if (segs.length === 0 || segs[0] === 'healthz') {
    if (method === 'GET') {
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 405, { message: 'Method Not Allowed' });
    }
    return;
  }

  const first = segs[0];
  if (first === 'api') {
    if (segs[1] === 'graphql') {
      if (!tokenOk(token)) { sendJson(res, 401, { message: 'Bad credentials' }); return; }
      const body = method === 'POST' ? await readBody(req as never, res as never) : Buffer.alloc(0);
      const args: GraphQLArgs = {
        method,
        body: body.toString('utf8'),
        token,
        origin: '',
        store,
      };
      await handleGraphQL(args, req, res);
      return;
    }
    if (segs[1] === 'v3' || segs[1] === 'v2' || segs[1] === 'v1' || segs[1] === undefined) {
      if (segs[1] === 'v3') {
        const restSegs = segs.slice(2);
        await dispatchRest(method, restSegs, url, token, req, res, store);
        return;
      }
      const restSegs = segs.slice(1);
      await dispatchRest(method, restSegs, url, token, req, res, store);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (first === 'user' || first === 'repos' || first === 'meta' || first === 'rate_limit') {
    await dispatchRest(method, segs, url, token, req, res, store);
    return;
  }

  if (first === 'graphql') {
    if (!tokenOk(token)) { sendJson(res, 401, { message: 'Bad credentials' }); return; }
    const body = method === 'POST' ? await readBody(req as never, res as never) : Buffer.alloc(0);
    const args: GraphQLArgs = { method, body: body.toString('utf8'), token, origin: '', store };
    await handleGraphQL(args, req, res);
    return;
  }

  if (first === 'mcp') {
    await handleMcp({ method, body: '', token, headers: req.headers, store } as McpArgs, req, res);
    return;
  }

  if (segs.length >= 2) {
    await handleGit(store, segs, method, url, req, res, 'git-upload-pack');
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

async function dispatchRest(
  method: string,
  restSegs: string[],
  url: string,
  token: string,
  req: { headers: Record<string, string | undefined>; url?: string },
  res: { writeHead: (code: number, headers: Record<string, string | number>) => void; end: (data: Buffer | string) => void },
  store: Store,
): Promise<void> {
  if (!tokenOk(token)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  const bodyStr = (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')
    ? (await readBody(req as never, res as never)).toString('utf8')
    : '';
  const u = new URL(req.url ?? url, 'http://x');
  const args: RestArgs = {
    method,
    segments: restSegs,
    query: u.searchParams,
    body: bodyStr,
    token,
    origin: '',
  };
  const requestId = nextRequestId();
  const r = await handleRest(store, args, requestId);
  const status = r.status;
  const headers: Record<string, string | number> = {
    'content-type': r.contentType ?? 'application/json',
    'x-github-request-id': requestId,
  };
  if (r.headers) {
    for (const [k, v] of Object.entries(r.headers)) headers[k] = v;
  }
  if (r.bodyBuffer) {
    headers['content-length'] = r.bodyBuffer.length;
    res.writeHead(status, headers);
    res.end(r.bodyBuffer);
  } else {
    const payload = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    headers['content-length'] = Buffer.byteLength(payload);
    res.writeHead(status, headers);
    res.end(payload);
  }
}

function urlFormat(url: string): string {
  return url;
}

export async function startServer(opts: {
  host?: string;
  port?: number;
  store?: Store;
} = {}): Promise<RunningServer> {
  const store = opts.store ?? new Store();
  const server = createServer(async (req, res) => {
    try {
      await dispatch(req, res, store);
    } catch (err) {
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
      } catch {
        // response already sent
      }
    }
  });
  const host = opts.host ?? (ENV_URL !== '' ? '127.0.0.1' : undefined);
  const port = opts.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind a TCP port');
  return { server, port: address.port };
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // not done yet; poll again
    }
    await sleep(retryDelay(attempt));
  }
}

async function main(): Promise<void> {
  if (ENV_URL !== '') {
    const { server, port } = await startServer();
    process.stdout.write(`[entry] listening on port ${port}\n`);
    await register(port);
    process.stdout.write('[entry] registered; waiting for the env to say done\n');
    await waitForDone();
    server.close();
    process.stdout.write('[entry] done\n');
    process.exit(0);
    return;
  }
  const { server, port } = await startServer();
  process.stdout.write(`PORT=${port}\n`);
  await new Promise<void>((resolve) => {
    const shutdown = () => server.close(() => resolve());
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  });
  process.exit(0);
}

const isMain = typeof require !== 'undefined' && require.main === module
  ? true
  : process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}