import type { ServerResponse } from 'node:http';
import {
  ZERO_OID,
  bumpRepoCache,
  hashObject,
  parseTree,
  buildTree,
  parseCommit,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
  type Repo,
  type Store,
  type Issue,
  type Pull,
  type Comment,
  type User,
  type Label,
} from './store.ts';
import { repoHeadOid, mergeBaseOf, isAncestor } from './git.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

export function sendBuffer(res: ServerResponse, status: number, buf: Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': buf.length, ...headers });
  res.end(buf);
}

export function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

const userJsonCache = new WeakMap<User, Record<string, unknown>>();

function userJson(user: User): Record<string, unknown> {
  const hit = userJsonCache.get(user);
  if (hit !== undefined) return hit;
  const out = { login: user.login, id: user.id, avatar_url: '', gravatar_id: '', url: '', html_url: '', type: 'User', name: user.name, email: user.email };
  userJsonCache.set(user, out);
  return out;
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

function commentJson(c: Comment): Record<string, unknown> {
  return { id: c.id, user: userJson(c.user), body: c.body, created_at: c.createdAt, updated_at: c.updatedAt };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const labels = issue.labels.map((name) => {
    const label = repo.labels.get(name);
    return label ? labelJson(label) : { name, color: 'ededed', description: '' };
  });
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(issue.user),
    labels,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    comments_url: '',
    html_url: '',
    url: '',
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'merged' ? 'closed' : pull.state,
    user: userJson(pull.user),
    head: { ref: pull.head, sha: headSha, label: `${repo.owner.login}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner.login}:${pull.base}` },
    merged: pull.merged,
    mergeable: pull.mergeable,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    merged_at: pull.mergedAt,
    html_url: '',
    url: '',
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(repo.owner),
    private: repo.private,
    html_url: '',
    url: '',
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    size: repo.size,
  };
}

export function branchJson(repo: Repo, name: string, oid: string): Record<string, unknown> {
  return { name, commit: { sha: oid, url: '' }, protected: false };
}

export function treeOf(repo: Repo, oid: string): TreeEntry[] | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const view = parseCommit(obj.data);
  const tree = repo.objects.get(view.tree);
  return tree && tree.type === 'tree' ? parseTree(tree.data) : null;
}

export function findPath(repo: Repo, oid: string, segments: string[]): string | null {
  const entries = treeOf(repo, oid);
  if (entries === null) return null;
  let current: TreeEntry[] = entries;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const entry = current.find((e) => e.name === seg);
    if (!entry) return null;
    if (i === segments.length - 1) return entry.oid;
    const sub = repo.objects.get(entry.oid);
    if (!sub || sub.type !== 'tree') return null;
    current = parseTree(sub.data);
  }
  return null;
}

export function writePathTree(repo: Repo, baseTree: TreeEntry[] | null, segments: string[], blobOid: string): string {
  const entries = baseTree === null ? [] : baseTree.map((e) => ({ mode: e.mode, name: e.name, oid: e.oid }));
  const build = (list: TreeEntry[], path: string[], index: number): string => {
    const seg = path[index];
    if (index === path.length - 1) {
      const without = list.filter((e) => e.name !== seg);
      without.push({ mode: '100644', name: seg, oid: blobOid });
      return putTree(repo, without);
    }
    const existing = list.find((e) => e.name === seg);
    let sub: TreeEntry[] = [];
    if (existing && existing.mode === '40000') {
      const obj = repo.objects.get(existing.oid);
      if (obj && obj.type === 'tree') sub = parseTree(obj.data);
    }
    const newSub = build(sub, path, index + 1);
    const without = list.filter((e) => e.name !== seg);
    without.push({ mode: '40000', name: seg, oid: newSub });
    return putTree(repo, without);
  };
  return build(entries, segments, 0);
}

function deletePathTree(repo: Repo, baseTree: TreeEntry[] | null, segments: string[]): string {
  const entries = baseTree === null ? [] : baseTree.map((e) => ({ mode: e.mode, name: e.name, oid: e.oid }));
  const remove = (list: TreeEntry[], path: string[], index: number): TreeEntry[] => {
    const seg = path[index];
    const existing = list.find((e) => e.name === seg);
    if (existing === undefined) return list;
    const without = list.filter((e) => e.name !== seg);
    if (index === path.length - 1) return without;
    if (existing.mode !== '40000') return list;
    const obj = repo.objects.get(existing.oid);
    if (obj === undefined || obj.type !== 'tree') return list;
    const sub = remove(parseTree(obj.data), path, index + 1);
    if (sub.length > 0) without.push({ mode: '40000', name: seg, oid: putTree(repo, sub) });
    return without;
  };
  return putTree(repo, remove(entries, segments, 0));
}

function putTree(repo: Repo, entries: TreeEntry[]): string {
  const data = buildTree(entries);
  const oid = hashObject('tree', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
  return oid;
}

export function putCommit(repo: Repo, tree: string, parents: string[], message: string): string {
  const parentLines = parents.map((parent) => `parent ${parent}\n`).join('');
  const data = Buffer.from(`tree ${tree}\n${parentLines}author ${repo.owner.name} <${repo.owner.email}> ${1700000000} +0000\ncommitter ${repo.owner.name} <${repo.owner.email}> ${1700000000} +0000\n\n${message}`, 'utf8');
  const oid = hashObject('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  return oid;
}

export function commitView(repo: Repo, oid: string): { tree: string; parents: string[]; message: string } | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data);
}

export function commitList(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (oid: string): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    const view = commitView(repo, oid);
    if (view === null) return;
    for (const p of view.parents) visit(p);
    out.push(oid);
  };
  visit(tip);
  return out;
}

export interface PathDiff {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export function diffTrees(repo: Repo, baseOid: string | null, headOid: string | null): PathDiff[] {
  const collect = (oid: string | null): Map<string, { mode: string; oid: string }> => {
    const files = new Map<string, { mode: string; oid: string }>();
    if (oid === null) return files;
    const view = commitView(repo, oid);
    if (view === null) return files;
    const walk = (treeOid: string, prefix: string): void => {
      const obj = repo.objects.get(treeOid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') {
          walk(entry.oid, path);
          continue;
        }
        files.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(view.tree, '');
    return files;
  };
  const baseFiles = collect(baseOid);
  const headFiles = collect(headOid);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const diffs: PathDiff[] = [];
  for (const path of paths) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before?.oid === after?.oid) continue;
    const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    const beforeSize = before === undefined ? 0 : blobSize(repo, before.oid);
    const afterSize = after === undefined ? 0 : blobSize(repo, after.oid);
    diffs.push({ filename: path, status, additions: Math.max(0, afterSize - beforeSize), deletions: Math.max(0, beforeSize - afterSize), changes: Math.abs(afterSize - beforeSize) });
  }
  return diffs;
}

function blobSize(repo: Repo, oid: string): number {
  const obj = repo.objects.get(oid);
  return obj?.type === 'blob' ? obj.data.length : 0;
}

export interface NewRepo {
  repo: Repo;
  message: string | null;
}

export function createRepo(store: Store, user: User, name: string, description: string, privateRepo: boolean, autoInit: boolean): NewRepo {
  const id = store.nextRepoId;
  store.nextRepoId += 1;
  const fullName = `${user.login}/${name}`;
  const iso = store.nowIso;
  const repo: Repo = {
    id,
    owner: user,
    name,
    fullName,
    description,
    private: privateRepo,
    defaultBranch: 'main',
    createdAt: iso,
    updatedAt: iso,
    pushedAt: iso,
    size: 0,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    issueByNumber: new Map(),
    pullByNumber: new Map(),
    headOid: ZERO_OID,
    depth1Pack: null,
    cacheRev: 0,
  };
  let message: string | null = null;
  if (autoInit) {
    const treeOid = putTree(repo, []);
    const commitOid = putCommit(repo, treeOid, [], 'Initial commit\n');
    repo.refs.set(`refs/heads/${repo.defaultBranch}`, commitOid);
    repo.headOid = commitOid;
    message = 'Initial commit\n';
  }
  store.repos.set(fullName, repo);
  return { repo, message };
}

export function getRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== store.viewer.login) return null;
  return store.repos.get(`${owner}/${name}`) ?? null;
}

export function lookupUser(store: Store, login: string): User | null {
  return store.users.get(login) ?? null;
}

export interface RestArgs {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: string;
  token: string;
  origin: string;
}

function apiPath(...segments: Array<string | number>): string {
  return `/api/v3/${segments.map((s) => String(s)).join('/')}`;
}

function parseSegments(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = parseInt(query.get('per_page') ?? '30', 10) || 30;
  const page = parseInt(query.get('page') ?? '1', 10) || 1;
  return { perPage, page };
}

export function handleRest(store: Store, args: RestArgs, res: ServerResponse): void {
  const { method, segments, query, body, token } = args;
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', current_user_authorizations_html_url: '', authorizations_url: '' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    return notFound(res);
  }
  const first = segments[0];
  if (first === 'meta') {
    if (method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0', github: { api: 'v3', version: '2026-07-28' }, hooks: [], pages: [], shops: [] });
      return;
    }
    return notFound(res);
  }
  if (first === 'user') {
    handleUser(store, args, res);
    return;
  }
  if (first === 'repos') {
    handleRepo(store, args, res);
    return;
  }
  if (first === 'rate_limit') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 5000, reset: 0 }, search: { limit: 10, remaining: 10, reset: 0 }, graphql: { limit: 5000, remaining: 5000, reset: 0 } }, rate: { limit: 5000, remaining: 5000, reset: 0 } });
    return;
  }
  notFound(res);
}

function handleUser(store: Store, args: RestArgs, res: ServerResponse): void {
  const { method, segments, query, body } = args;
  const viewer = store.viewer;
  if (segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, userJson(viewer));
      return;
    }
    return notFound(res);
  }
  if (segments[1] === 'repos') {
    if (method === 'GET') {
      const { perPage, page } = parseSegments(query);
      const all = [...store.repos.values()].filter((r) => r.owner.login === viewer.login).map(repoJson);
      const start = (page - 1) * perPage;
      const items = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) headers.link = `<${args.origin}${apiPath('user', 'repos')}?per_page=${perPage}&page=${page + 1}>; rel="next"`;
      sendJson(res, 200, items, headers);
      return;
    }
    if (method === 'POST') {
      let name = '';
      let description = '';
      let privateRepo = false;
      let autoInit = false;
      try {
        const parsed = body === '' ? {} : JSON.parse(body);
        name = String(parsed.name ?? '');
        description = String(parsed.description ?? '');
        privateRepo = parsed.private === true;
        autoInit = parsed.auto_init === true;
      } catch {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }
      if (name === '') {
        sendJson(res, 422, { message: 'Invalid request.', errors: [{ code: 'missing_field', field: 'name' }] });
        return;
      }
      if (store.repos.has(`${viewer.login}/${name}`)) {
        sendJson(res, 422, { message: `Repository ${name} already exists`, errors: [] });
        return;
      }
      const { repo } = createRepo(store, viewer, name, description, privateRepo, autoInit);
      sendJson(res, 201, repoJson(repo));
      return;
    }
    return notFound(res);
  }
  notFound(res);
}

function handleRepo(store: Store, args: RestArgs, res: ServerResponse): void {
  const { method, segments, query, body } = args;
  if (segments.length < 3) return notFound(res);
  const owner = segments[1];
  const name = segments[2];
  const repo = getRepo(store, owner, name);
  if (segments.length === 3) {
    if (repo === null) {
      if (method === 'DELETE') { sendJson(res, 204, {}); return; }
      return notFound(res);
    }
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = body === '' ? {} : JSON.parse(body);
      } catch {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }
      if (typeof parsed.description === 'string') repo.description = parsed.description;
      if (typeof parsed.default_branch === 'string') {
        const newBranch = parsed.default_branch;
        if (repo.refs.has(`refs/heads/${newBranch}`) && newBranch !== repo.defaultBranch) {
          repo.defaultBranch = newBranch;
          bumpRepoCache(repo);
        }
      }
      repo.updatedAt = store.nowIso;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      store.repos.delete(`${owner}/${name}`);
      sendJson(res, 204, {});
      return;
    }
    return notFound(res);
  }
  if (repo === null) {
    if (method === 'GET' && segments[3] === 'issues') { sendJson(res, 200, []); return; }
    return notFound(res);
  }
  const sub = segments[3];
  const rest = segments.slice(4);
  if (sub === 'contents') {
    handleContents(repo, store.nowIso, method, query, body, rest, res);
    return;
  }
  if (sub === 'branches') {
    if (method === 'GET') {
      const branches = [...repo.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, oid]) => branchJson(repo, ref.slice('refs/heads/'.length), oid));
      sendJson(res, 200, branches);
      return;
    }
    return notFound(res);
  }
  if (sub === 'commits') {
    if (method === 'GET') {
      const requested = query.get('sha');
      const branchRef = requested === null || requested.startsWith('refs/heads/') ? requested : `refs/heads/${requested}`;
      const tip = branchRef === null
        ? repo.refs.get(`refs/heads/${repo.defaultBranch}`)
        : repo.refs.get(branchRef) ?? (requested !== null && repo.objects.has(requested) ? requested : undefined);
      const list = tip === undefined ? [] : commitList(repo, tip).map((oid) => ({ sha: oid, commit: { message: commitView(repo, oid)?.message ?? '', url: '' }, url: '' }));
      sendJson(res, 200, list);
      return;
    }
    return notFound(res);
  }
  if (sub === 'git') {
    handleGitRefs(repo, method, body, rest, res);
    return;
  }
  if (sub === 'issues') {
    handleIssues(store, repo, method, query, body, rest, res);
    return;
  }
  if (sub === 'labels') {
    handleLabels(repo, method, body, res);
    return;
  }
  if (sub === 'pulls') {
    handlePulls(store, repo, method, query, body, rest, res);
    return;
  }
  notFound(res);
}

function handleGitRefs(repo: Repo, method: string, body: string, rest: string[], res: ServerResponse): void {
  if (method === 'GET') {
    const refs = [...repo.refs].map(([ref, oid]) => ({ ref, object: { sha: oid, type: 'commit', url: '' } }));
    sendJson(res, 200, refs);
    return;
  }
  if (method === 'POST' && rest.length >= 1 && rest[0] === 'refs') {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    const ref = String(parsed.ref ?? '');
    const sha = String(parsed.sha ?? '');
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
      sendJson(res, 422, { message: 'Invalid request.', errors: [] });
      return;
    }
    if (!repo.objects.has(sha)) {
      sendJson(res, 422, { message: 'Invalid request.', errors: [{ code: 'invalid', field: 'sha' }] });
      return;
    }
    if (repo.refs.has(ref)) {
      sendJson(res, 422, { message: 'Reference already exists', errors: [] });
      return;
    }
    repo.refs.set(ref, sha);
    bumpRepoCache(repo);
    sendJson(res, 201, { ref, object: { sha, type: 'commit', url: '' } });
    return;
  }
  notFound(res);
}

function handleContents(repo: Repo, nowIso: string, method: string, query: URLSearchParams, body: string, rest: string[], res: ServerResponse): void {
  const requestedPath = rest.length > 0 ? rest.join('/') : query.get('path') ?? '';
  const segments = requestedPath.split('/').filter(Boolean);
  let bodyBranch: string | null = null;
  if (method !== 'GET') {
    try {
      const parsed = body === '' ? {} : JSON.parse(body);
      if (typeof parsed.branch === 'string' && parsed.branch.length > 0) bodyBranch = parsed.branch;
    } catch {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
  }
  const branch = query.get('branch') ?? query.get('ref') ?? bodyBranch ?? repo.defaultBranch;
  const ref = query.get('ref') ?? branch;
  if (method === 'GET') {
    const tip = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/heads/${branch}`) ?? repo.headOid;
    if (tip === ZERO_OID || !repo.objects.has(tip)) return notFound(res);
    const oid = findPath(repo, tip, segments);
    if (oid === null) return notFound(res);
    const obj = repo.objects.get(oid);
    if (!obj) return notFound(res);
    if (obj.type === 'tree') {
      const basePath = segments.join('/');
      const entries = parseTree(obj.data).map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: basePath === '' ? entry.name : `${basePath}/${entry.name}`,
        sha: entry.oid,
      }));
      sendJson(res, 200, entries);
      return;
    }
    if (obj.type !== 'blob') return notFound(res);
    const content = obj.data.toString('base64');
    sendJson(res, 200, { type: 'file', encoding: 'base64', size: obj.data.length, name: segments[segments.length - 1] ?? '', path: segments.join('/'), content, sha: oid, url: '' });
    return;
  }
  if (method === 'PUT') {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    const contentB64 = String(parsed.content ?? '');
    const message = String(parsed.message ?? '');
    const sha = parsed.sha !== undefined ? String(parsed.sha) : undefined;
    const putBranch = query.get('branch') ?? query.get('ref') ?? (typeof parsed.branch === 'string' && parsed.branch.length > 0 ? parsed.branch : repo.defaultBranch);
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    const blobOid = hashObject('blob', content);
    if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: 'blob', data: content });
    const tip = repo.refs.get(`refs/heads/${putBranch}`);
    const parent = tip && repo.objects.has(tip) ? tip : null;
    const existing = parent === null ? null : findPath(repo, parent, segments);
    if (existing !== null && sha !== undefined && existing !== sha) {
      sendJson(res, 409, { message: 'Invalid request.', errors: [{ code: 'sha_mismatch', field: 'sha' }] });
      return;
    }
    const baseTree = parent ? treeOf(repo, parent) : null;
    const newTree = writePathTree(repo, baseTree, segments, blobOid);
    const commitOid = putCommit(repo, newTree, parent ? [parent] : [], message);
    repo.refs.set(`refs/heads/${putBranch}`, commitOid);
    bumpRepoCache(repo);
    if (putBranch === repo.defaultBranch) repo.headOid = commitOid;
    repo.pushedAt = nowIso;
    sendJson(res, existing === null ? 201 : 200, { content: { name: segments[segments.length - 1] ?? '', path: segments.join('/'), sha: blobOid, size: content.length, type: 'file', encoding: 'base64', content: contentB64 }, commit: { sha: commitOid, url: '' } });
    return;
  }
  if (method === 'DELETE') {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    const message = String(parsed.message ?? '');
    const sha = parsed.sha !== undefined ? String(parsed.sha) : undefined;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const parent = tip && repo.objects.has(tip) ? tip : null;
    const existing = parent === null ? null : findPath(repo, parent, segments);
    if (existing === null) return notFound(res);
    if (sha !== undefined && existing !== sha) {
      sendJson(res, 409, { message: 'Invalid request.', errors: [{ code: 'sha_mismatch', field: 'sha' }] });
      return;
    }
    const baseTree = parent ? treeOf(repo, parent) : null;
    const newTree = deletePathTree(repo, baseTree, segments);
    const commitOid = putCommit(repo, newTree, parent ? [parent] : [], message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    bumpRepoCache(repo);
    if (branch === repo.defaultBranch) repo.headOid = commitOid;
    repo.pushedAt = nowIso;
    sendJson(res, 200, { commit: { sha: commitOid, url: '' }, content: null });
    return;
  }
  notFound(res);
}

function handleLabels(repo: Repo, method: string, body: string, res: ServerResponse): void {
  if (method === 'GET') {
    sendJson(res, 200, [...repo.labels.values()].map(labelJson));
    return;
  }
  if (method === 'POST') {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    const name = String(parsed.name ?? '');
    const color = String(parsed.color ?? 'ededed');
    const description = String(parsed.description ?? '');
    if (repo.labels.has(name)) {
      sendJson(res, 422, { message: 'Validation Failed', errors: [{ code: 'already_exists', field: 'name' }] });
      return;
    }
    repo.labels.set(name, { name, color, description });
    sendJson(res, 201, labelJson(repo.labels.get(name)!));
    return;
  }
  notFound(res);
}

function handleIssues(store: Store, repo: Repo, method: string, query: URLSearchParams, body: string, rest: string[], res: ServerResponse): void {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const { perPage, page } = parseSegments(query);
      let issues = repo.issues;
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      if (query.get('direction') === 'asc') issues = [...issues];
      else issues = [...issues].reverse();
      const start = (page - 1) * perPage;
      const items = issues.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < issues.length) headers.link = `<${apiPath('repos', repo.owner.login, repo.name, 'issues')}?state=${state}&per_page=${perPage}&page=${page + 1}>; rel="next"`;
      sendJson(res, 200, items.map((i) => issueJson(repo, i)), headers);
      return;
    }
    if (method === 'POST') {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }
      const title = String(parsed.title ?? '');
      const issueBody = String(parsed.body ?? '');
      const labels = Array.isArray(parsed.labels) ? parsed.labels.map((l) => String(l)) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ code: 'invalid', field: 'labels', value: label }] });
          return;
        }
      }
      const number = repo.issues.length + 1;
      const id = store.nextIssueId;
      store.nextIssueId += 1;
      const now = store.nowIso;
      const issue: Issue = { id, number, title, body: issueBody, user: store.viewer, state: 'open', labels, createdAt: now, updatedAt: now, comments: [] };
      repo.issues.push(issue);
      repo.issueByNumber.set(number, issue);
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    return notFound(res);
  }
  const number = parseInt(rest[0], 10);
  const issue = repo.issueByNumber.get(number);
  if (issue === undefined) return notFound(res);
  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }
      if (typeof parsed.state === 'string' && (parsed.state === 'open' || parsed.state === 'closed')) {
        issue.state = parsed.state;
        issue.updatedAt = store.nowIso;
      }
      if (typeof parsed.title === 'string') issue.title = parsed.title;
      if (typeof parsed.body === 'string') issue.body = parsed.body;
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    return notFound(res);
  }
  if (rest[1] === 'comments') {
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map(commentJson));
      return;
    }
    if (method === 'POST') {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }
      const commentBody = String(parsed.body ?? '');
      const id = store.nextCommentId;
      store.nextCommentId += 1;
      const now = store.nowIso;
      const comment: Comment = { id, user: store.viewer, body: commentBody, createdAt: now, updatedAt: now };
      issue.comments.push(comment);
      sendJson(res, 201, commentJson(comment));
      return;
    }
    return notFound(res);
  }
  notFound(res);
}

function handlePulls(store: Store, repo: Repo, method: string, query: URLSearchParams, body: string, rest: string[], res: ServerResponse): void {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const { perPage, page } = parseSegments(query);
      let pulls = repo.pulls;
      if (state !== 'all') pulls = pulls.filter((p) => (state === 'closed' ? p.state !== 'open' : p.state === state));
      const start = (page - 1) * perPage;
      const items = pulls.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < pulls.length) headers.link = `<${apiPath('repos', repo.owner.login, repo.name, 'pulls')}?state=${state}&per_page=${perPage}&page=${page + 1}>; rel="next"`;
      sendJson(res, 200, items.map((p) => pullJson(repo, p)), headers);
      return;
    }
    if (method === 'POST') {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }
      const head = String(parsed.head ?? '');
      const base = String(parsed.base ?? repo.defaultBranch);
      const title = String(parsed.title ?? '');
      const pullBody = String(parsed.body ?? '');
      const headTip = repo.refs.get(`refs/heads/${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (headTip === undefined || baseTip === undefined) {
        sendJson(res, 422, { message: 'No commits between the base and the head', errors: [] });
        return;
      }
      const number = repo.pulls.length + 1;
      const id = store.nextPullId;
      store.nextPullId += 1;
      const now = store.nowIso;
      const pull: Pull = { id, number, title, body: pullBody, user: store.viewer, state: 'open', head, base, headSha: headTip, baseSha: baseTip, mergeCommitSha: null, merged: false, mergeable: true, createdAt: now, updatedAt: now, mergedAt: null };
      repo.pulls.push(pull);
      repo.pullByNumber.set(number, pull);
      sendJson(res, 201, pullJson(repo, pull));
      return;
    }
    return notFound(res);
  }
  const number = parseInt(rest[0], 10);
  const pull = repo.pullByNumber.get(number);
  if (pull === undefined) return notFound(res);
  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    if (method === 'PATCH') {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }
      if (parsed.state === 'closed') {
        pull.state = 'closed';
        pull.updatedAt = store.nowIso;
      }
      if (typeof parsed.title === 'string') pull.title = parsed.title;
      if (typeof parsed.body === 'string') pull.body = parsed.body;
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    return notFound(res);
  }
  if (rest[1] === 'merge') {
    if (method === 'PUT') {
      if (pull.state !== 'open') {
        sendJson(res, 405, { message: 'Pull Request is not mergeable' });
        return;
      }
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
      const headTip = repo.refs.get(`refs/heads/${pull.head}`);
      if (baseTip === undefined || headTip === undefined) {
        sendJson(res, 405, { message: 'Pull Request is not mergeable' });
        return;
      }
      const baseView = commitView(repo, baseTip);
      const headView = commitView(repo, headTip);
      if (baseView === null || headView === null) {
        sendJson(res, 405, { message: 'Pull Request is not mergeable' });
        return;
      }
      const mergeBase = mergeBaseOf(repo, baseTip, headTip);
      const baseDiffs = diffTrees(repo, mergeBase, baseTip);
      const headDiffs = diffTrees(repo, mergeBase, headTip);
      const basePaths = new Set(baseDiffs.map((d) => d.filename));
      const conflict = headDiffs.find((d) => basePaths.has(d.filename));
      if (conflict) {
        sendJson(res, 405, { message: 'Pull Request is not mergeable' });
        return;
      }
      const mergeTree = headView.tree;
      const mergeCommit = putCommit(repo, mergeTree, [baseTip, headTip], `Merge pull request #${number}\n`);
      repo.refs.set(`refs/heads/${pull.base}`, mergeCommit);
      bumpRepoCache(repo);
      if (pull.base === repo.defaultBranch) repo.headOid = mergeCommit;
      pull.state = 'merged';
      pull.merged = true;
      pull.mergeCommitSha = mergeCommit;
      pull.mergeable = true;
      pull.mergedAt = store.nowIso;
      pull.updatedAt = store.nowIso;
      sendJson(res, 200, { merged: true, sha: mergeCommit, message: `Merge pull request #${number}\n` });
      return;
    }
    return notFound(res);
  }
  if (rest[1] === 'files') {
    if (method === 'GET') {
      const baseTip = pull.baseSha;
      const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
      const diffs = diffTrees(repo, baseTip, headTip);
      sendJson(res, 200, diffs);
      return;
    }
    return notFound(res);
  }
  if (rest[1] === 'comments') {
    if (method === 'GET') {
      sendJson(res, 200, []);
      return;
    }
    if (method === 'POST') {
      const id = store.nextCommentId;
      store.nextCommentId += 1;
      sendJson(res, 201, { id, body: '', user: userJson(store.viewer), created_at: store.nowIso, updated_at: store.nowIso });
      return;
    }
    return notFound(res);
  }
  notFound(res);
}

export function mergeTrees(repo: Repo, baseTip: string, headTip: string, mergeBase: string): string {
  const headDiffs = diffTrees(repo, mergeBase, headTip);
  const tree = treeOf(repo, baseTip);
  const changes = new Map<string, { oid: string; mode: string }>();
  for (const d of headDiffs) {
    const oid = findPath(repo, headTip, d.filename.split('/'));
    if (oid !== null) {
      const obj = repo.objects.get(oid);
      changes.set(d.filename, { oid, mode: '100644' });
    } else {
      changes.set(d.filename, { oid: '', mode: '' });
    }
  }
  return applyTreeChanges(repo, tree, changes);
}

function applyTreeChanges(repo: Repo, tree: TreeEntry[] | null, changes: Map<string, { oid: string; mode: string }>): string {
  let entries = (tree ?? []).map((e) => ({ mode: e.mode, name: e.name, oid: e.oid }));
  const apply = (list: TreeEntry[], segments: string[], index: number, change: { oid: string; mode: string }): string => {
    const seg = segments[index];
    if (index === segments.length - 1) {
      const without = list.filter((e) => e.name !== seg);
      if (change.oid !== '') without.push({ mode: change.mode, name: seg, oid: change.oid });
      return putTree(repo, without);
    }
    const existing = list.find((e) => e.name === seg);
    let sub: TreeEntry[] = [];
    if (existing && existing.mode === '40000') {
      const obj = repo.objects.get(existing.oid);
      if (obj && obj.type === 'tree') sub = parseTree(obj.data);
    }
    const newSub = apply(sub, segments, index + 1, change);
    const without = list.filter((e) => e.name !== seg);
    without.push({ mode: '40000', name: seg, oid: newSub });
    return putTree(repo, without);
  };
  for (const [path, change] of changes) {
    const merged = apply(entries, path.split('/'), 0, change);
    const obj = repo.objects.get(merged);
    entries = obj?.type === 'tree' ? parseTree(obj.data) : entries;
  }
  return putTree(repo, entries);
}
