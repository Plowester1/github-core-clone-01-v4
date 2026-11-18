import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  bumpRepoCache,
  hashObject,
  parseTree,
  parseCommit,
  parseTag,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
  type Repo,
} from './store.ts';

export type GitService = 'git-upload-pack' | 'git-receive-pack';

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export interface GitPacket {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
  raw: Buffer;
}

export function decodePktLines(bytes: Buffer): GitPacket[] {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const lenHex = bytes.subarray(offset, offset + 4).toString('ascii');
    const length = Number.parseInt(lenHex, 16);
    if (!Number.isFinite(length)) break;
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0), raw: bytes.subarray(offset, offset + 4) });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0), raw: bytes.subarray(offset, offset + 4) });
      offset += 4;
    } else if (length >= 4 && offset + length <= bytes.length) {
      packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length), raw: bytes.subarray(offset, offset + length) });
      offset += length;
    } else break;
  }
  return packets;
}

export function encodePktLines(items: ReadonlyArray<string | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export interface PackParseResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
  count: number;
}

export function readPack(data: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackParseResult {
  const version = data.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const count = data.readUInt32BE(8);
  const objects: Map<string, GitObject> = new Map();
  const oidByOffset = new Map<number, string>();
  let pos = 12;
  let deltaCount = 0;
  const rawTypes: number[] = [];
  const rawData: Buffer[] = [];
  const rawOffsets: number[] = [];
  const refOffsets: Array<{ ref: number | null; base: string | null }> = [];
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    const typeByte = data[pos];
    const type = (typeByte >> 4) & 0x07;
    let c = typeByte;
    let size = c & 0x0f;
    let shift = 4;
    pos += 1;
    while (c & 0x80) {
      c = data[pos];
      pos += 1;
      size |= (c & 0x7f) << shift;
      shift += 7;
    }
    let ref: number | null = null;
    let base: string | null = null;
    if (type === 6) {
      let ofs = 0;
      let byte = data[pos];
      pos += 1;
      ofs = byte & 0x7f;
      while (byte & 0x80) {
        byte = data[pos];
        pos += 1;
        ofs = ((ofs + 1) << 7) | (byte & 0x7f);
      }
      ref = start - ofs;
    } else if (type === 7) {
      base = data.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const { out, next } = inflateOne(data, pos);
    if (out.length !== size) throw new Error(`pack object size mismatch: expected ${size}, got ${out.length}`);
    pos = next;
    rawTypes.push(type);
    rawData.push(out);
    rawOffsets.push(start);
    refOffsets.push({ ref, base });
    if (type >= 1 && type <= 4) {
      const t = CODE_TYPE[type];
      const oid = hashObject(t, out);
      objects.set(oid, { type: t, data: out });
      oidByOffset.set(start, oid);
    }
  }
  for (let i = 0; i < count; i += 1) {
    const type = rawTypes[i];
    if (type === 6) {
      const ref = refOffsets[i].ref;
      if (ref === null) throw new Error('bad ofs delta');
      const target = oidByOffset.get(ref);
      const baseObj = target === undefined ? undefined : objects.get(target);
      if (baseObj === undefined) throw new Error('ofs delta base missing');
      const resolved = applyDelta(baseObj.data, rawData[i]);
      const oid = hashObject(baseObj.type, resolved);
      objects.set(oid, { type: baseObj.type, data: resolved });
      oidByOffset.set(rawOffsets[i], oid);
      deltaCount += 1;
    } else if (type === 7) {
      const base = refOffsets[i].base;
      const baseObj = base === null ? undefined : objects.get(base) ?? resolveBase?.(base);
      if (baseObj === undefined) throw new Error('ref delta base missing');
      const resolved = applyDelta(baseObj.data, rawData[i]);
      const oid = hashObject(baseObj.type, resolved);
      objects.set(oid, { type: baseObj.type, data: resolved });
      oidByOffset.set(rawOffsets[i], oid);
      deltaCount += 1;
    }
  }
  return { objects, deltaCount, count };
}

function inflateOne(data: Buffer, start: number): { out: Buffer; next: number } {
  const inflated = inflateSync(data.subarray(start), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { out: inflated.buffer, next: start + inflated.engine.bytesWritten };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let shift = 0;
    let result = 0;
    while (true) {
      const byte = delta[pos];
      pos += 1;
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return result;
  };
  readVarint();
  readVarint();
  const out: Buffer[] = [];
  while (pos < delta.length) {
    const cmd = delta[pos];
    pos += 1;
    if (cmd & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      if (cmd & 0x01) copyOff |= delta[pos++] << 0;
      if (cmd & 0x02) copyOff |= delta[pos++] << 8;
      if (cmd & 0x04) copyOff |= delta[pos++] << 16;
      if (cmd & 0x08) copyOff |= delta[pos++] << 24;
      if (cmd & 0x10) copySize |= delta[pos++] << 0;
      if (cmd & 0x20) copySize |= delta[pos++] << 8;
      if (cmd & 0x40) copySize |= delta[pos++] << 16;
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOff, copyOff + copySize));
    } else if (cmd) {
      out.push(delta.subarray(pos, pos + cmd));
      pos += cmd;
    }
  }
  return Buffer.concat(out);
}

export function writePack(objects: ReadonlyArray<{ type: GitObjectType; data: Buffer }>): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const chunks: Buffer[] = [header];
  for (const obj of objects) {
    const typeCode = TYPE_CODE[obj.type];
    const deflated = deflateSync(obj.data);
    const size = obj.data.length;
    const bytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    let rest = size >>> 4;
    if (rest > 0) first |= 0x80;
    bytes.push(first);
    while (rest > 0) {
      let b = rest & 0x7f;
      rest >>>= 7;
      if (rest > 0) b |= 0x80;
      bytes.push(b);
    }
    chunks.push(Buffer.from(bytes), deflated);
  }
  const body = Buffer.concat(chunks);
  const h = createHash('sha1');
  h.update(body);
  const trailer = h.digest();
  return Buffer.concat([body, trailer]);
}

export function collectReachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      queue.push(view.tree);
      for (const p of view.parents) queue.push(p);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      const view = parseTag(obj.data);
      queue.push(view.object);
    }
  }
  return seen;
}

function reachableCommits(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    const view = parseCommit(obj.data);
    for (const p of view.parents) queue.push(p);
  }
  return seen;
}

export function repoHeadOid(repo: Repo): string {
  let tip = ZERO_OID;
  for (const [ref, oid] of repo.refs) {
    if (ref.startsWith('refs/heads/')) {
      tip = oid;
      break;
    }
  }
  return tip;
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    if (oid === ancestor) return true;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const view = parseCommit(obj.data);
    for (const p of view.parents) queue.push(p);
  }
  return false;
}

export function mergeBaseOf(repo: Repo, a: string, b: string): string {
  if (a === b) return a;
  const ancestorsA = reachableCommits(repo, [a]);
  const seen = new Set<string>();
  const queue: string[] = [b];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const view = parseCommit(obj.data);
    for (const p of view.parents) queue.push(p);
  }
  return a;
}

export function buildDepth1Pack(repo: Repo, tip: string): Buffer {
  const obj = repo.objects.get(tip);
  if (!obj || obj.type !== 'commit') return writePack([]);
  const view = parseCommit(obj.data);
  const toSend: Array<{ type: GitObjectType; data: Buffer }> = [];
  const seen = new Set<string>();
  const add = (oid: string): void => {
    if (seen.has(oid)) return;
    const o = repo.objects.get(oid);
    if (!o) return;
    seen.add(oid);
    toSend.push({ type: o.type, data: o.data });
    if (o.type === 'tree') {
      for (const entry of parseTree(o.data)) {
        if (entry.mode === '160000') continue;
        add(entry.oid);
      }
    }
  };
  add(view.tree);
  add(tip);
  return writePack(toSend);
}

export interface AdvertisedRef {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
}

interface GitResponseCache {
  rev: number;
  advV0Upload: Buffer | null;
  advV0Receive: Buffer | null;
  advV2Upload: Buffer | null;
  lsRefs: Map<string, Buffer>;
  fetchDepth1: Map<string, Buffer>;
}
const gitResponseCache = new WeakMap<Repo, GitResponseCache>();

function responseCacheFor(repo: Repo): GitResponseCache {
  let entry = gitResponseCache.get(repo);
  if (entry === undefined || entry.rev !== repo.cacheRev) {
    entry = { rev: repo.cacheRev, advV0Upload: null, advV0Receive: null, advV2Upload: null, lsRefs: new Map(), fetchDepth1: new Map() };
    gitResponseCache.set(repo, entry);
  }
  return entry;
}

function advertisedRefs(repo: Repo): AdvertisedRef[] {
  const refs: AdvertisedRef[] = [];
  const headName = repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? repo.defaultBranch : ['main', 'develop', 'master'].find((name) => repo.refs.has(`refs/heads/${name}`)) ?? repo.defaultBranch;
  const head = repo.refs.get(`refs/heads/${headName}`);
  refs.push({ name: 'HEAD', oid: head ?? ZERO_OID, symrefTarget: `refs/heads/${headName}` });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    refs.push({ name, oid });
    if (name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const view = parseTag(obj.data);
        refs.push({ name, oid, peeled: view.object });
      }
    }
  }
  return refs;
}

export function advertiseV0(repo: Repo, service: GitService): Buffer {
  const cache = responseCacheFor(repo);
  if (service === 'git-receive-pack') {
    if (cache.advV0Receive === null) cache.advV0Receive = buildAdvertiseV0(repo, service);
    return cache.advV0Receive;
  }
  if (cache.advV0Upload === null) cache.advV0Upload = buildAdvertiseV0(repo, service);
  return cache.advV0Upload;
}

function buildAdvertiseV0(repo: Repo, service: GitService): Buffer {
  const lines: Array<string | 'flush'> = [];
  const caps = service === 'git-receive-pack'
    ? ['report-status-v2', 'report-status', 'side-band-64k', 'ofs-delta', 'agent=makefun/1.0', 'delete-refs', 'object-format=sha1']
    : ['multi_ack_detailed', 'side-band-64k', 'ofs-delta', 'agent=makefun/1.0', 'shallow'];
  let first = true;
  const refs = advertisedRefs(repo);
  for (const ref of refs) {
    if (first) {
      const advertisedCaps = ref.symrefTarget === undefined ? caps : [...caps, `symref=HEAD:${ref.symrefTarget}`];
      lines.push(`${ref.oid} ${ref.name}\u0000${advertisedCaps.join(' ')}`);
    } else {
      lines.push(`${ref.oid} ${ref.name}`);
    }
    first = false;
    if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}`);
  }
  if (refs.length === 0) lines.push(`0000000000000000000000000000000000000000 capabilities^{}\u0000${caps.join(' ')}`);
  lines.push('flush');
  const preamble = encodePktLine(`# service=${service}\n`);
  const body = Buffer.concat([preamble, pktFlush(), encodePktLines(lines)]);
  return body;
}

export function advertiseV2(repo: Repo, service: GitService): Buffer {
  if (service !== 'git-upload-pack') return advertiseV0(repo, service);
  const cache = responseCacheFor(repo);
  if (cache.advV2Upload === null) cache.advV2Upload = buildAdvertiseV2(repo, service);
  return cache.advV2Upload;
}

function buildAdvertiseV2(repo: Repo, service: GitService): Buffer {
  const caps = ['version 2', 'agent=makefun/1.0', 'object-format=sha1', 'ls-refs=unborn', 'fetch=shallow wait-for-done filter'];
  const lines = caps.map((c) => `${c}\n`);
  lines.push('flush');
  return encodePktLines(lines);
}

export function parseLsRefsRequest(body: Buffer): string[] | null {
  const lines: string[] = [];
  for (const packet of decodePktLines(body)) {
    if (packet.kind !== 'data') continue;
    for (const line of packet.payload.toString('utf8').split('\n')) {
      if (line !== '') lines.push(line);
    }
  }
  if (!lines.includes('command=ls-refs')) return null;
  return lines.filter((line) => line === 'peel' || line === 'symrefs' || line === 'unborn' || line.startsWith('ref-prefix '));
}

export function lsRefsV2(repo: Repo, requestLines: string[]): Buffer {
  const cache = responseCacheFor(repo);
  const key = requestLines.join('\n');
  const hit = cache.lsRefs.get(key);
  if (hit !== undefined) return hit;
  const out = buildLsRefsV2(repo, requestLines);
  cache.lsRefs.set(key, out);
  return out;
}

function buildLsRefsV2(repo: Repo, requestLines: string[]): Buffer {
  const peel = requestLines.includes('peel');
  const symrefs = requestLines.includes('symrefs');
  const prefixes = requestLines.filter((l) => l.startsWith('ref-prefix ')).map((l) => l.slice('ref-prefix '.length));
  const refs = advertisedRefs(repo);
  const peeledByName = new Map<string, string>();
  for (const ref of refs) {
    if (ref.peeled !== undefined) peeledByName.set(ref.name, ref.peeled);
  }
  const lines: Array<string | 'flush'> = [];
  const emitted = new Set<string>();
  for (const ref of refs) {
    if (emitted.has(ref.name)) continue;
    emitted.add(ref.name);
    if (prefixes.length && !prefixes.some((p) => ref.name.startsWith(p))) continue;
    let line = ref.name === 'HEAD' && symrefs && ref.symrefTarget ? `${ref.oid} ${ref.name} symref-target:${ref.symrefTarget}` : `${ref.oid} ${ref.name}`;
    const peeled = ref.peeled ?? peeledByName.get(ref.name);
    if (peel && peeled !== undefined) line += ` peeled:${peeled}`;
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

export function parseFetchRequest(body: Buffer, isV2: boolean): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: true };
  const packets = decodePktLines(body);
  const lines: string[] = [];
  if (isV2) {
    let inArgs = false;
    for (const p of packets) {
      if (p.kind === 'delim') {
        inArgs = true;
        continue;
      }
      if (p.kind === 'flush') continue;
      if (inArgs) lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
    }
  } else {
    for (const p of packets) {
      if (p.kind === 'flush') continue;
      if (p.kind === 'delim') continue;
      lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
    }
  }
  let sawDone = false;
  for (const line of lines) {
    if (line.startsWith('want ')) {
      const first = line.slice(5);
      const space = first.indexOf(' ');
      req.wants.push(space < 0 ? first : first.slice(0, space));
    } else if (line.startsWith('have ')) req.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) req.depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'done') sawDone = true;
  }
  req.done = sawDone;
  return req;
}

function buildFetchPack(repo: Repo, req: FetchRequest): Buffer {
  const tips = req.wants.filter((oid) => repo.objects.has(oid));
  const wantSet = new Set(tips);
  const shallowRequest = req.depth !== null || req.shallow.length > 0;
  const haveSet = new Set<string>();
  for (const h of req.haves) {
    const o = repo.objects.get(h);
    if (o && o.type === 'commit') {
      if (shallowRequest) haveSet.add(h);
      else {
        for (const oid of collectReachable(repo, [h])) haveSet.add(oid);
      }
    }
  }
  const depth = req.depth;
  const toSend: Array<{ type: GitObjectType; data: Buffer }> = [];
  const sent = new Set<string>();
  const walk = (oid: string, level: number): void => {
    if (sent.has(oid)) return;
    if (!shallowRequest && haveSet.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (!obj) return;
    if (obj.type === 'commit' && depth !== null && level >= depth) return;
    sent.add(oid);
    if (!haveSet.has(oid)) toSend.push({ type: obj.type, data: obj.data });
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      if (!haveSet.has(oid)) walk(view.tree, level + 1);
      for (const p of view.parents) walk(p, level + 1);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        walk(entry.oid, level);
      }
    } else if (obj.type === 'tag') {
      const view = parseTag(obj.data);
      walk(view.object, level);
    }
  };
  for (const want of wantSet) walk(want, 0);
  return writePack(toSend);
}

interface ShallowInfo {
  shallow: string[];
  unshallow: string[];
}

function packSentCommits(repo: Repo, pack: Buffer): Set<string> {
  const parsed = readPack(pack, (oid) => repo.objects.get(oid));
  const commits = new Set<string>();
  for (const [oid, obj] of parsed.objects) {
    if (obj.type === 'commit') commits.add(oid);
  }
  return commits;
}

function deepestSentCommit(repo: Repo, wants: readonly string[], sentCommits: Set<string>): string | undefined {
  let deepest: string | undefined;
  let deepestLevel = -1;
  for (const want of wants) {
    const seen = new Set<string>();
    const queue: Array<{ oid: string; level: number }> = [{ oid: want, level: 0 }];
    while (queue.length) {
      const current = queue.pop()!;
      if (seen.has(current.oid)) continue;
      seen.add(current.oid);
      if (sentCommits.has(current.oid) && current.level > deepestLevel) {
        deepest = current.oid;
        deepestLevel = current.level;
      }
      const obj = repo.objects.get(current.oid);
      if (!obj || obj.type !== 'commit') continue;
      const view = parseCommit(obj.data);
      for (const parent of view.parents) queue.push({ oid: parent, level: current.level + 1 });
    }
  }
  return deepest;
}

function shallowInfoFor(repo: Repo, req: FetchRequest, pack: Buffer, fallbackTip: string): ShallowInfo {
  const sentCommits = req.depth === 1 ? new Set([fallbackTip]) : packSentCommits(repo, pack);
  const unshallow = req.shallow.filter((boundary) => {
    const obj = repo.objects.get(boundary);
    if (!obj || obj.type !== 'commit') return false;
    const view = parseCommit(obj.data);
    return view.parents.some((parent) => sentCommits.has(parent));
  });
  const shallow = req.shallow.filter((boundary) => !unshallow.includes(boundary));
  const deepest = req.depth === 1 ? fallbackTip : deepestSentCommit(repo, req.wants, sentCommits);
  if (deepest !== undefined && !shallow.includes(deepest)) shallow.push(deepest);
  return { shallow, unshallow };
}

function shallowPackFor(repo: Repo, tip: string): Buffer {
  if (repo.depth1Pack === null) repo.depth1Pack = buildDepth1Pack(repo, tip);
  return repo.depth1Pack;
}

export function fetchResponse(repo: Repo, req: FetchRequest, isV2: boolean): Buffer {
  if (req.depth === 1 && req.haves.length === 0 && req.wants.length === 1) {
    const cache = responseCacheFor(repo);
    const key = `${isV2 ? 'v2' : 'v0'}|${req.wants[0]}|${req.shallow.join(',')}`;
    const hit = cache.fetchDepth1.get(key);
    if (hit !== undefined) return hit;
    const out = buildFetchResponse(repo, req, isV2);
    cache.fetchDepth1.set(key, out);
    return out;
  }
  return buildFetchResponse(repo, req, isV2);
}

function buildFetchResponse(repo: Repo, req: FetchRequest, isV2: boolean): Buffer {
  const wantTip = req.wants[0];
  const hasTip = repo.refs.get('refs/heads/main') ?? req.wants[0];
  const pack = req.depth === 1 ? shallowPackFor(repo, hasTip) : buildFetchPack(repo, req);
  const shallowInfo = req.depth !== null || req.shallow.length > 0 ? shallowInfoFor(repo, req, pack, hasTip) : { shallow: [], unshallow: [] };
  const parts: Buffer[] = [];
  if (isV2) {
    if (req.haves.length > 0) {
      parts.push(encodePktLine('acknowledgments\n'));
      let acked = false;
      for (const have of req.haves) {
        if (repo.objects.has(have)) {
          parts.push(encodePktLine(`ACK ${have}\n`));
          acked = true;
        }
      }
      if (!acked) parts.push(encodePktLine('NAK\n'));
      parts.push(encodePktLine('ready\n'));
      parts.push(pktDelim());
    }
    if (shallowInfo.shallow.length > 0 || shallowInfo.unshallow.length > 0) {
      parts.push(encodePktLine('shallow-info\n'));
      for (const s of shallowInfo.shallow) parts.push(encodePktLine(`shallow ${s}\n`));
      for (const s of shallowInfo.unshallow) parts.push(encodePktLine(`unshallow ${s}\n`));
      parts.push(pktDelim());
    }
    parts.push(encodePktLine('packfile\n'));
    const sideband = sidebandPack(pack);
    parts.push(sideband);
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  const chunk = sidebandPack(pack);
  const shallowLines: Buffer[] = [];
  for (const s of shallowInfo.shallow) shallowLines.push(encodePktLine(`shallow ${s}\n`));
  for (const s of shallowInfo.unshallow) shallowLines.push(encodePktLine(`unshallow ${s}\n`));
  return Buffer.concat([...shallowLines, encodePktLine('NAK\n'), chunk, pktFlush()]);
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const MAX = 65515;
  for (let i = 0; i < pack.length; i += MAX) {
    const chunk = pack.subarray(i, i + MAX);
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

export interface PushResultRef {
  ref: string;
  ok: boolean;
  reason: string;
}
export interface PushReport {
  unpackOk: boolean;
  unpackDetail: string;
  refs: PushResultRef[];
}

export function receivePack(repo: Repo, body: Buffer): Buffer {
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let sideband = false;
  let packStart = body.length;
  let offset = 0;
  let i = 0;
  while (offset + 4 <= body.length) {
    const length = Number.parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (!Number.isFinite(length) || length <= 0) {
      if (length === 0) offset += 4;
      break;
    }
    if (offset + length > body.length) break;
    const payload = body.subarray(offset + 4, offset + length);
    if (length === 4) {
      offset += length;
      break;
    }
    offset += length;
    i += 1;
    const line = payload.toString('utf8').replace(/\r$/, '').replace(/\n$/, '');
    const nulPos = line.indexOf('\u0000');
    const cmdLine = nulPos < 0 ? line : line.slice(0, nulPos);
    const caps = nulPos < 0 ? '' : line.slice(nulPos + 1);
    if (i === 1 && caps.includes('side-band-64k')) sideband = true;
    const sp1 = cmdLine.indexOf(' ');
    const sp2 = cmdLine.indexOf(' ', sp1 + 1);
    if (sp1 < 0 || sp2 < 0) continue;
    commands.push({ oldOid: cmdLine.slice(0, sp1), newOid: cmdLine.slice(sp1 + 1, sp2), ref: cmdLine.slice(sp2 + 1) });
  }
  packStart = offset;
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  let reportRefs: PushResultRef[] = [];
  try {
    if (packBytes.length >= 4 && packBytes.subarray(0, 4).toString('ascii') === 'PACK') {
      const parsed = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of parsed.objects) repo.objects.set(oid, obj);
    }
  } catch (err) {
    unpackOk = false;
    unpackDetail = `error ${err instanceof Error ? err.message : String(err)}`;
  }
  reportRefs = commands.map((cmd) => {
    if (cmd.newOid === ZERO_OID) {
      repo.refs.delete(cmd.ref);
      bumpRepoCache(repo);
      return { ref: cmd.ref, ok: true, reason: '' };
    }
    if (cmd.oldOid === ZERO_OID) {
      if (repo.refs.has(cmd.ref)) return { ref: cmd.ref, ok: false, reason: 'non-fast-forward' };
    } else {
      const current = repo.refs.get(cmd.ref);
      if (current === undefined || current !== cmd.oldOid) return { ref: cmd.ref, ok: false, reason: 'non-fast-forward' };
      if (!repo.objects.has(cmd.newOid)) return { ref: cmd.ref, ok: false, reason: 'missing-object' };
      if (!isAncestor(repo, current, cmd.newOid)) return { ref: cmd.ref, ok: false, reason: 'non-fast-forward' };
    }
    if (!repo.objects.has(cmd.newOid)) return { ref: cmd.ref, ok: false, reason: 'missing-object' };
    repo.refs.set(cmd.ref, cmd.newOid);
    bumpRepoCache(repo);
    return { ref: cmd.ref, ok: true, reason: '' };
  });
  const reportLines: Array<string | 'flush'> = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const r of reportRefs) reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  const report = encodePktLines(reportLines);
  if (sideband) {
    const framed = Buffer.concat([Buffer.from([1]), report, pktFlush()]);
    return Buffer.concat([encodePktLine(framed), pktFlush()]);
  }
  return Buffer.concat([report, pktFlush()]);
}