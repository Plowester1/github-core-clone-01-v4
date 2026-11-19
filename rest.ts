// GitHub REST API v3 for the make.fun github-core-clone-01 forge.
// Routes the /api/v3 surface: repos, contents, commits, branches, git/refs,
// issues, labels, comments and pull requests (including files and merge).
// JSON only, never HTML, with an incrementing X-GitHub-Request-Id header and
// JSON {message} error bodies. Bearer auth is enforced upstream in main.ts,
// so every handler here may assume it is already acting as the viewer.

import {
  Store,
  bumpRepoCache,
  hashObject,
  buildTree,
  parseTree,
  buildCommit,
  parseCommit,
  isoOf,
  ZERO_OID,
} from './store.ts';
import type {
  Repo,
  GitObject,
  User,
  Label,
  Issue,
  Pull,
  Comment,
  TreeEntry,
  CommitView,
} from './store.ts';
import { repoHeadOid, isAncestor, mergeBaseOf } from './git.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** The viewer's fixed identity (never octocat). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'Ada Iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** Incoming REST request the server hands to this module. */
export interface RestArgs {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: string;
  token: string | null;
  origin: string;
}

/** The structured reply this module returns for the server to write out. */
export interface RestResult {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
  contentType: string;
}

/** One changed path produced by diffing two trees. */
export interface PathDiff {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  oldOid?: string;
  newOid?: string;
}

/** A body for POST /user/repos. */
export interface NewRepo {
  name: string;
  description?: string;
  private?: boolean;
  defaultBranch?: string;
  auto_init?: boolean;
}

/** Memoised serialization of a user so repeated replies stay cheap. */
const userJsonMemo = new Map<string, string>();

function userKey(user: User): string {
  return `${user.login}\u0000${user.id}\u0000${user.name}\u0000${user.email}\u0000${user.createdAt}`;
}

export function lookupUser(store: Store, login: string): User | undefined {
  return store.findUser(login) ?? (login === store.viewer.login ? store.viewer : undefined);
}

/** Build the GitHub "user" object for one stored user. */
export function userJson(user: User): Record<string, unknown> {
  const cached = userJsonMemo.get(userKey(user));
  if (cached !== undefined) return JSON.parse(cached) as Record<string, unknown>;
  const json: Record<string, unknown> = {
    login: user.login,
    id: user.id,
    name: user.name,
    email: user.email,
    created_at: user.createdAt,
    type: 'User',
  };
  userJsonMemo.set(userKey(user), JSON.stringify(json));
  return json;
}

/** Serialise a JSON success reply with the request-id header set. */
export function sendJson(requestId: string, status: number, body: unknown): RestResult {
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId,
    'x-oauth-scopes': 'repo',
  };
  return { status, headers, body: JSON.stringify(body), contentType: JSON_TYPE };
}

/** Serialise a binary reply (used for git smart-HTTP payloads). */
export function sendBuffer(requestId: string, status: number, buffer: Buffer, contentType: string): RestResult {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'x-github-request-id': requestId,
    'x-oauth-scopes': 'repo',
  };
  return { status, headers, body: buffer, contentType };
}

/** A JSON {message} not-found error. */
export function notFound(requestId: string, message: string): RestResult {
  return sendJson(requestId, 404, { message });
}

/** A JSON error of an arbitrary status. */
export function jsonError(requestId: string, status: number, message: string): RestResult {
  return sendJson(requestId, status, { message });
}

/** Defensively parse the request body as JSON; a malformed body is a 400, never a crash. */
function jsonBody(args: RestArgs, requestId: string): { value: unknown; error: RestResult | null } {
  if (args.body.trim() === '') return { value: {}, error: null };
  try {
    return { value: JSON.parse(args.body), error: null };
  } catch {
    return { value: null, error: jsonError(requestId, 400, 'Problems parsing JSON') };
  }
}

// -----------------------------------------------------------------------------
// Object and tree helpers
// -----------------------------------------------------------------------------

/** Store a hash-addressed object in the repo if it is not already present. */
function putObject(repo: Repo, type: 'blob' | 'tree' | 'commit' | 'tag', data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function lookupOid(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** Resolve a revision (ref name or oid) to a commit oid; null means the head. */
function resolveCommit(repo: Repo, rev: string | null): string | null {
  if (rev === null || rev === '') return repoHeadOid(repo);
  if (rev === 'HEAD') return repoHeadOid(repo);
  const full = rev.startsWith('refs/') ? rev : `refs/heads/${rev}`;
  const oid = repo.refs.get(full);
  if (oid !== undefined) return oid;
  if (repo.refs.has(rev)) return repo.refs.get(rev) as string;
  if (repo.objects.has(rev)) return rev;
  return null;
}

/** The tree oid of a revision's commit, or null when unborn/missing. */
export function treeOf(repo: Repo, rev: string | null): string | null {
  const commitOid = resolveCommit(repo, rev);
  if (commitOid === null || commitOid === ZERO_OID) return null;
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  const view = parseCommit(object.data);
  return view.tree;
}

/** Navigate a tree to a path; returns the found entry or null. */
export function findPath(repo: Repo, treeOid: string | null, path: string): TreeEntry | null {
  if (treeOid === null) return null;
  const segments = path.split('/').filter((part) => part.length > 0);
  let current: TreeEntry | null = null;
  let oid = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return null;
    const entries = parseTree(object.data);
    const name = segments[index];
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry) return null;
    current = entry;
    if (index < segments.length - 1) oid = entry.oid;
  }
  return current;
}

/**
 * Build a new tree from a base tree with a path set (newOid) or removed (null).
 * Directories keep mode 40000, files 100644. The result is stored and returned.
 */
export function writePathTree(store: Store, repo: Repo, baseTreeOid: string | null, path: string, newOid: string | null, mode = '100644'): string {
  const segments = path.split('/').filter((part) => part.length > 0);
  const build = (treeOid: string | null, parts: string[]): string => {
    const entries: TreeEntry[] = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
    const head = parts[0];
    if (parts.length === 1) {
      const kept = entries.filter((entry) => entry.name !== head);
      if (newOid !== null) kept.push({ mode, name: head, oid: newOid });
      const sorted = sortEntries(kept);
      const data = buildTree(sorted);
      return putObject(repo, 'tree', data);
    }
    const child = entries.find((entry) => entry.name === head);
    const childTree = child ? build(child.oid, parts.slice(1)) : build(null, parts.slice(1));
    const kept = entries.filter((entry) => entry.name !== head);
    kept.push({ mode: '40000', name: head, oid: childTree });
    const data = buildTree(sortEntries(kept));
    return putObject(repo, 'tree', data);
  };
  return build(baseTreeOid, segments);
}

/** Order tree entries with directories sorting as `name/`. */
function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const aName = a.mode === '40000' ? `${a.name}/` : a.name;
    const bName = b.mode === '40000' ? `${b.name}/` : b.name;
    return aName < bName ? -1 : aName > bName ? 1 : 0;
  });
}

/** The viewer identity for author/committer/tagger lines. */
function viewerIdentity(store: Store): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${store.epochSec} +0000`;
}

/**
 * Build and store a commit object with `parent` lines, update the branch ref and
 * bump the response cache. Returns the new commit oid.
 */
export function putCommit(store: Store, repo: Repo, branch: string, treeOid: string, parents: string[], message: string): string {
  const identity = viewerIdentity(store);
  const text = message.endsWith('\n') ? message : `${message}\n`;
  const data = buildCommit({
    tree: treeOid,
    parents,
    author: identity,
    committer: identity,
    message: text,
  });
  const oid = putObject(repo, 'commit', data);
  const fullRef = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  repo.refs.set(fullRef, oid);
  repo.headOid = oid;
  repo.pushedAt = store.nowIso;
  repo.updatedAt = store.nowIso;
  repo.size = 0;
  for (const object of repo.objects.values()) repo.size += object.data.length;
  bumpRepoCache(repo);
  return oid;
}

/** One commit's GitHub JSON (the checks read `sha` and `commit.message`). */
export function commitView(store: Store, repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const commit: CommitView = object && object.type === 'commit' ? parseCommit(object.data) : { tree: ZERO_OID, parents: [], author: '', committer: '', message: '' };
  return {
    sha: oid,
    node_id: oid,
    commit: {
      message: commit.message,
      tree: { sha: commit.tree },
      author: personOf(store, commit.author),
      committer: personOf(store, commit.committer),
      parents: commit.parents.map((parent) => ({ sha: parent })),
      verification: { verified: false, reason: 'unsigned' },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

/** Split a "Name <email> ts +0000" identity line into a GitHub person object. */
function personOf(store: Store, identity: string): Record<string, unknown> {
  const match = /^(.*?)\s*<([^>]*)>\s*(\d+)(?:\s*([+-]\d+))?/.exec(identity ?? '');
  const name = match?.[1]?.trim() || '';
  const email = match?.[2] ?? '';
  const timestamp = match?.[3] ? Number(match[3]) : store.epochSec;
  return {
    name,
    email,
    date: isoOf(timestamp),
  };
}

/** List commits reachable from a tip, newest first (parents written as `parent` lines in storage). */
export function commitList(store: Store, repo: Repo, tipOid: string | null): Record<string, unknown>[] {
  if (tipOid === null || tipOid === ZERO_OID) return [];
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const stack = [tipOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(commitView(store, repo, oid));
    const view = parseCommit(object.data);
    for (let index = view.parents.length - 1; index >= 0; index -= 1) stack.push(view.parents[index]);
  }
  return out;
}

/** Diff two trees into a list of path changes with line counts. */
export function diffTrees(store: Store, repo: Repo, oldOid: string | null, newOid: string | null): PathDiff[] {
  const out: PathDiff[] = [];
  const oldBlobs = collectBlobs(repo, oldOid);
  const newBlobs = collectBlobs(repo, newOid);
  const allPaths = new Set([...oldBlobs.keys(), ...newBlobs.keys()]);
  for (const path of [...allPaths].sort()) {
    const oldSha = oldBlobs.get(path);
    const newSha = newBlobs.get(path);
    if (oldSha === undefined && newSha !== undefined) {
      out.push({ path, status: 'added', additions: lineCount(repo, newSha), deletions: 0, changes: lineCount(repo, newSha), newOid: newSha });
    } else if (oldSha !== undefined && newSha === undefined) {
      out.push({ path, status: 'removed', additions: 0, deletions: lineCount(repo, oldSha), changes: lineCount(repo, oldSha), oldOid: oldSha });
    } else if (oldSha !== undefined && newSha !== undefined && oldSha !== newSha) {
      out.push({ path, status: 'modified', additions: lineCount(repo, newSha), deletions: lineCount(repo, oldSha), changes: lineCount(repo, newSha) + lineCount(repo, oldSha), oldOid: oldSha, newOid: newSha });
    }
  }
  return out;
}

/** Collect path -> blob oid for every file reachable from a tree. */
function collectBlobs(repo: Repo, treeOid: string | null): Map<string, string> {
  const result = new Map<string, string>();
  if (treeOid === null) return result;
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else result.set(path, entry.oid);
    }
  };
  walk(treeOid, '');
  return result;
}

/** Count the lines a blob would contribute as additions/deletions. */
function lineCount(repo: Repo, oid: string): number {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'blob') return 0;
  return countLines(object.data);
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

// -----------------------------------------------------------------------------
// Repository JSON and handlers
// -----------------------------------------------------------------------------

/** The GitHub repository object for one stored repo. */
export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = lookupUser(store, repo.owner) ?? store.viewer;
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    size: repo.size,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    html_url: `${owner.login}/${repo.name}`,
    clone_url: `${owner.login}/${repo.name}.git`,
    git_url: `${owner.login}/${repo.name}.git`,
    ssh_url: `git@github.com:${owner.login}/${repo.name}.git`,
    url: `repos/${repo.fullName}`,
    has_issues: true,
    has_wiki: true,
    archived: false,
  };
}

/** The GitHub branch object for one ref. */
export function branchJson(store: Store, repo: Repo, refName: string, oid: string): Record<string, unknown> {
  const short = refName.replace(/^refs\/heads\//, '');
  return {
    name: short,
    commit: { sha: oid, url: `commits/${oid}` },
    protected: false,
  };
}

/** Look up a repo by "owner/name" full name, or by (owner, name). */
function storeRepo(store: Store, owner: string, name: string): Repo | undefined {
  return store.getRepo(`${owner}/${name}`);
}

/**
 * Create a repository under the viewer (POST /user/repos). Returns a 201 with the
 * created repository, or a 422 when a repository by that name already exists.
 */
export function createRepo(store: Store, args: RestArgs, requestId: string): RestResult {
  const parsed = jsonBody(args, requestId);
  if (parsed.error) return parsed.error;
  const input = (parsed.value ?? {}) as NewRepo;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') return jsonError(requestId, 422, 'name is missing');
  const owner = store.viewer.login;
  if (store.getRepo(`${owner}/${name}`)) return jsonError(requestId, 422, 'Repository creation failed.');
  const repo = store.createRepo(owner, name, {
    description: typeof input.description === 'string' ? input.description : '',
    private: input.private === true,
    defaultBranch: typeof input.defaultBranch === 'string' && input.defaultBranch !== '' ? input.defaultBranch : 'main',
  });
  if (input.auto_init === true) {
    const emptyTree = putObject(repo, 'tree', buildTree([]));
    putCommit(store, repo, repo.defaultBranch, emptyTree, [], 'Initial commit');
  }
  return sendJson(requestId, 201, repoJson(store, repo));
}

/** Get a repository (GET /repos/{owner}/{name}); 404 when absent. */
export function getRepo(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  return sendJson(requestId, 200, repoJson(store, repo));
}

/** List a user's repositories with per_page/rel=next pagination. */
function listUserRepos(store: Store, args: RestArgs, requestId: string): RestResult {
  const user = store.viewer;
  const repos = [...store.repos.values()]
    .filter((repo) => repo.owner === user.login)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return paginateRepos(store, args, requestId, repos);
}

/** Apply per_page/sort/direction pagination and emit a Link rel="next" header. */
function paginateRepos(store: Store, args: RestArgs, requestId: string, repos: Repo[]): RestResult {
  const perPage = clampInt(args.query.get('per_page'), 30, 1, 100);
  const page = clampInt(args.query.get('page'), 1, 1, Number.MAX_SAFE_INTEGER);
  const total = repos.length;
  const start = (page - 1) * perPage;
  const slice = repos.slice(start, start + perPage);
  const body = slice.map((repo) => repoJson(store, repo));
  const headers: Record<string, string> = {};
  const next = start + perPage < total ? page + 1 : null;
  if (next !== null) {
    const url = `${args.origin}/api/v3/user/repos?per_page=${perPage}&page=${next}`;
    headers.link = `<${url}>; rel="next"`;
  }
  return { status: 200, headers: { ...{ 'content-type': JSON_TYPE, 'x-github-request-id': requestId, 'x-oauth-scopes': 'repo' }, ...headers }, body: JSON.stringify(body), contentType: JSON_TYPE };
}

/** Parse an integer query value with a default and a clamp. */
function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

// -----------------------------------------------------------------------------
// Contents, labels, issues and comments
// -----------------------------------------------------------------------------

/** The GitHub label object. */
export function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description };
}

/** The GitHub comment object. */
export function commentJson(store: Store, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    body: comment.body,
  };
}

/** The GitHub issue object. */
export function issueJson(store: Store, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(issue.user),
    labels: issue.labels.map(labelJson),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.map((comment) => commentJson(store, comment)),
  };
}

/** The GitHub pull-request object (an issue plus head/base refs and merge state). */
export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const json = issueJson(store, pull);
  return {
    ...json,
    head: { ref: pull.head, sha: resolveCommit(repo, pull.head) ?? ZERO_OID },
    base: { ref: pull.base, sha: resolveCommit(repo, pull.base) ?? ZERO_OID },
    merge_commit_sha: pull.merged ? pull.mergeCommitSha ?? ZERO_OID : null,
    merged: pull.merged,
    merged_at: pull.closedAt,
  };
}

/** Resolve the branch for a contents PUT: query ?branch=/?ref=, then body.branch, then default. */
function contentsBranch(store: Store, repo: Repo, args: RestArgs, parsed: Record<string, unknown>): string {
  const queryBranch = args.query.get('branch');
  if (queryBranch) return queryBranch;
  const queryRef = args.query.get('ref');
  if (queryRef) return queryRef;
  const bodyBranch = parsed.branch;
  if (typeof bodyBranch === 'string' && bodyBranch !== '') return bodyBranch;
  return repo.defaultBranch;
}

/** One file's GitHub contents object. */
function fileEntry(repo: Repo, entry: TreeEntry, path: string): Record<string, unknown> {
  const object = repo.objects.get(entry.oid);
  const data = object && object.type === 'blob' ? object.data : Buffer.alloc(0);
  return {
    type: 'file',
    name: path.split('/').pop() ?? path,
    path,
    sha: entry.oid,
    size: data.length,
    encoding: 'base64',
    content: data.toString('base64'),
  };
}

/** One directory entry for the contents listing. */
function dirEntry(repo: Repo, entry: TreeEntry, path: string): Record<string, unknown> {
  const isDir = entry.mode === '40000';
  return {
    type: isDir ? 'dir' : 'file',
    name: entry.name,
    path,
    sha: entry.oid,
    size: isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
  };
}

/** GET /repos/{o}/{r}/contents/{path}: a file or a directory listing. */
function contentsGet(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  const path = args.segments.slice(4).join('/');
  const ref = args.query.get('ref') ?? args.query.get('branch') ?? null;
  const tree = treeOf(repo, ref);
  const entry = findPath(repo, tree, path);
  if (!entry) return notFound(requestId, 'Not Found');
  if (entry.mode === '40000') {
    const treeObj = repo.objects.get(entry.oid);
    if (!treeObj || treeObj.type !== 'tree') return notFound(requestId, 'Not Found');
    const entries = parseTree(treeObj.data).map((child) => dirEntry(repo, child, `${path === '' ? child.name : `${path}/${child.name}`}`));
    return sendJson(requestId, 200, entries);
  }
  return sendJson(requestId, 200, fileEntry(repo, entry, path));
}

/** PUT /repos/{o}/{r}/contents/{path}: create or update a file, 409 on a stale sha. */
function contentsPut(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  const parsed = jsonBody(args, requestId);
  if (parsed.error) return parsed.error;
  const input = (parsed.value ?? {}) as Record<string, unknown>;
  const path = args.segments.slice(4).join('/');
  if (path === '') return jsonError(requestId, 422, 'path is required');
  const message = typeof input.message === 'string' ? input.message : '';
  const content = typeof input.content === 'string' ? input.content : null;
  if (content === null) return jsonError(requestId, 422, 'content is required');
  const branch = contentsBranch(store, repo, args, input);
  const data = Buffer.from(content, 'base64');
  const blobOid = putObject(repo, 'blob', data);
  const baseTree = treeOf(repo, branch);
  const current = findPath(repo, baseTree, path);
  const exists = current !== null;
  if (exists && typeof input.sha === 'string' && input.sha !== '' && current.oid !== input.sha) {
    return jsonError(requestId, 409, 'sha does not match the current blob');
  }
  const newTree = writePathTree(store, repo, baseTree, path, blobOid, '100644');
  const parent = resolveCommit(repo, branch);
  const commitOid = putCommit(store, repo, branch, newTree, parent ? [parent] : [], message);
  const entry: TreeEntry = { mode: '100644', name: path.split('/').pop() ?? path, oid: blobOid };
  return sendJson(requestId, exists ? 200 : 201, {
    content: fileEntry(repo, entry, path),
    commit: { sha: commitOid },
  });
}

/** DELETE /repos/{o}/{r}/contents/{path}: remove a file with a commit. */
function contentsDelete(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  const parsed = jsonBody(args, requestId);
  if (parsed.error) return parsed.error;
  const input = (parsed.value ?? {}) as Record<string, unknown>;
  const path = args.segments.slice(4).join('/');
  const branch = repo.defaultBranch;
  const message = typeof input.message === 'string' ? input.message : '';
  const baseTree = treeOf(repo, branch);
  const current = findPath(repo, baseTree, path);
  if (!current) return notFound(requestId, 'Not Found');
  if (typeof input.sha === 'string' && input.sha !== '' && current.oid !== input.sha) {
    return jsonError(requestId, 409, 'sha does not match the current blob');
  }
  const newTree = writePathTree(store, repo, baseTree, path, null);
  const parent = resolveCommit(repo, branch);
  const commitOid = putCommit(store, repo, branch, newTree, parent ? [parent] : [], message);
  return sendJson(requestId, 200, { commit: { sha: commitOid } });
}

/** POST /repos/{o}/{r}/labels: create a repository label. */
function labelsPost(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  const parsed = jsonBody(args, requestId);
  if (parsed.error) return parsed.error;
  const input = (parsed.value ?? {}) as Record<string, unknown>;
  const labelName = typeof input.name === 'string' ? input.name : '';
  if (labelName === '') return jsonError(requestId, 422, 'name is required');
  const label: Label = {
    id: store.nextRepoId + repo.labels.length + 1,
    name: labelName,
    color: typeof input.color === 'string' ? input.color : 'ededed',
    description: typeof input.description === 'string' ? input.description : '',
  };
  repo.labels.push(label);
  return sendJson(requestId, 201, labelJson(label));
}

/** Find a repo label by name; null when absent. */
function findLabel(repo: Repo, name: string): Label | undefined {
  return repo.labels.find((label) => label.name === name);
}

/** POST /repos/{o}/{r}/issues: create an issue; 422 on an unknown label. */
function issuesPost(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  const parsed = jsonBody(args, requestId);
  if (parsed.error) return parsed.error;
  const input = (parsed.value ?? {}) as Record<string, unknown>;
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') return jsonError(requestId, 422, 'title is required');
  const labelNames = Array.isArray(input.labels) ? (input.labels as unknown[]) : [];
  const labels: Label[] = [];
  for (const entry of labelNames) {
    const labelName = typeof entry === 'string' ? entry : (entry as Record<string, unknown>).name;
    const label = typeof labelName === 'string' ? findLabel(repo, labelName) : undefined;
    if (!label) return jsonError(requestId, 422, `Validation Failed`);
    labels.push(label);
  }
  const id = store.nextIssueId++;
  const now = store.nowIso;
  const issue: Issue = {
    id,
    number: id,
    user: store.viewer,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
  };
  repo.issues.push(issue);
  repo.issueByNumber.set(id, issue);
  bumpRepoCache(repo);
  return sendJson(requestId, 201, issueJson(store, issue));
}

/** GET /repos/{o}/{r}/issues: list with state/sort/direction filtering. */
function issuesList(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  const state = args.query.get('state') ?? 'open';
  const sort = args.query.get('sort') ?? 'created';
  const direction = args.query.get('direction') ?? 'desc';
  let list = repo.issues;
  if (state === 'open') list = list.filter((issue) => issue.state === 'open');
  else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
  const ordered = [...list].sort((a, b) => {
    const aTime = sort === 'updated' ? a.updatedAt : a.createdAt;
    const bTime = sort === 'updated' ? b.updatedAt : b.createdAt;
    const cmp = aTime < bTime ? -1 : aTime > bTime ? 1 : 0;
    if (cmp !== 0) return direction === 'asc' ? cmp : -cmp;
    return direction === 'asc' ? a.number - b.number : b.number - a.number;
  });
  return sendJson(requestId, 200, ordered.map((issue) => issueJson(store, issue)));
}

/** Look up an issue by its number in a repo; null when absent. */
function repoIssue(repo: Repo, number: number): Issue | undefined {
  return repo.issueByNumber.get(number);
}

/** GET /repos/{o}/{r}/issues/{n}: one issue. */
function issuesGetOne(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  const number = Number.parseInt(args.segments[4] ?? '', 10);
  const issue = repoIssue(repo, number);
  if (!issue) return notFound(requestId, 'Not Found');
  return sendJson(requestId, 200, issueJson(store, issue));
}

/** PATCH /repos/{o}/{r}/issues/{n}: open or close an issue. */
function issuesPatch(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  const number = Number.parseInt(args.segments[4] ?? '', 10);
  const issue = repoIssue(repo, number);
  if (!issue) return notFound(requestId, 'Not Found');
  const parsed = jsonBody(args, requestId);
  if (parsed.error) return parsed.error;
  const input = (parsed.value ?? {}) as Record<string, unknown>;
  const state = typeof input.state === 'string' ? input.state : issue.state;
  issue.state = state === 'closed' ? 'closed' : 'open';
  issue.updatedAt = store.nowIso;
  issue.closedAt = state === 'closed' ? store.nowIso : null;
  return sendJson(requestId, 200, issueJson(store, issue));
}

/** POST /repos/{o}/{r}/issues/{n}/comments: add a comment. */
function commentsPost(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  const number = Number.parseInt(args.segments[4] ?? '', 10);
  const issue = repoIssue(repo, number);
  if (!issue) return notFound(requestId, 'Not Found');
  const parsed = jsonBody(args, requestId);
  if (parsed.error) return parsed.error;
  const input = (parsed.value ?? {}) as Record<string, unknown>;
  const body = typeof input.body === 'string' ? input.body : '';
  const comment: Comment = {
    id: store.nextCommentId++,
    user: store.viewer,
    createdAt: store.nowIso,
    updatedAt: store.nowIso,
    body,
  };
  issue.comments.push(comment);
  return sendJson(requestId, 201, commentJson(store, comment));
}

/** GET /repos/{o}/{r}/issues/{n}/comments: list an issue's comments. */
function commentsList(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  const number = Number.parseInt(args.segments[4] ?? '', 10);
  const issue = repoIssue(repo, number);
  if (!issue) return notFound(requestId, 'Not Found');
  return sendJson(requestId, 200, issue.comments.map((comment) => commentJson(store, comment)));
}

// -----------------------------------------------------------------------------
// Pull requests, merges and the router
// -----------------------------------------------------------------------------

/**
 * Merge two branch tips, merge-base aware. Returns the merged tree or a conflict
 * flag. A path changed differently on both sides since the merge base is a conflict.
 */
export function mergeTrees(store: Store, repo: Repo, baseOid: string | null, headOid: string | null): { tree: string | null; conflict: boolean } {
  if (baseOid === null || baseOid === ZERO_OID) {
    return { tree: treeOf(repo, headOid), conflict: false };
  }
  if (headOid === null || headOid === ZERO_OID) {
    return { tree: treeOf(repo, baseOid), conflict: false };
  }
  const baseTree = treeOf(repo, baseOid);
  const headTree = treeOf(repo, headOid);
  const mergeBase = mergeBaseOf(baseOid, headOid, (oid) => repo.objects.get(oid));
  const mbTree = mergeBase ? treeOf(repo, mergeBase) : null;
  const baseDiff = diffTrees(store, repo, mbTree, baseTree);
  const headDiff = diffTrees(store, repo, mbTree, headTree);
  const baseByPath = new Map(baseDiff.map((diff) => [diff.path, diff]));
  for (const head of headDiff) {
    const base = baseByPath.get(head.path);
    if (!base) continue;
    const baseBlob = base.newOid ?? base.oldOid;
    const headBlob = head.newOid ?? head.oldOid;
    if (baseBlob !== headBlob) return { tree: null, conflict: true };
  }
  let tree = baseTree;
  for (const diff of headDiff) {
    if (diff.status === 'removed') tree = writePathTree(store, repo, tree, diff.path, null);
    else if (diff.newOid) tree = writePathTree(store, repo, tree, diff.path, diff.newOid, '100644');
  }
  return { tree, conflict: false };
}

/** POST /repos/{o}/{r}/pulls: open a pull request from a head branch onto a base. */
function pullsPost(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  const parsed = jsonBody(args, requestId);
  if (parsed.error) return parsed.error;
  const input = (parsed.value ?? {}) as Record<string, unknown>;
  const title = typeof input.title === 'string' ? input.title : '';
  const head = typeof input.head === 'string' ? input.head : '';
  const base = typeof input.base === 'string' && input.base !== '' ? input.base : repo.defaultBranch;
  if (head === '') return jsonError(requestId, 422, 'head is required');
  const id = store.nextPullId++;
  const now = store.nowIso;
  const pull: Pull = {
    id,
    number: id,
    user: store.viewer,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
    head,
    base,
  };
  repo.pulls.push(pull);
  repo.pullByNumber.set(id, pull);
  bumpRepoCache(repo);
  return sendJson(requestId, 201, pullJson(store, repo, pull));
}

/** GET /repos/{o}/{r}/pulls: list pulls, defaulting to open. */
function pullsList(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  const state = args.query.get('state') ?? 'open';
  let list = repo.pulls;
  if (state === 'open') list = list.filter((pull) => pull.state === 'open');
  else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
  return sendJson(requestId, 200, list.map((pull) => pullJson(store, repo, pull)));
}

/** A repo pull by number; null when absent. */
function repoPull(repo: Repo, number: number): Pull | undefined {
  return repo.pullByNumber.get(number);
}

/** GET /repos/{o}/{r}/pulls/{n}: one pull request. */
function pullsGetOne(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  const number = Number.parseInt(args.segments[4] ?? '', 10);
  const pull = repoPull(repo, number);
  if (!pull) return notFound(requestId, 'Not Found');
  return sendJson(requestId, 200, pullJson(store, repo, pull));
}

/** GET /repos/{o}/{r}/pulls/{n}/files: the changed paths between base and head. */
function pullsFiles(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  const number = Number.parseInt(args.segments[4] ?? '', 10);
  const pull = repoPull(repo, number);
  if (!pull) return notFound(requestId, 'Not Found');
  const baseTree = treeOf(repo, pull.base);
  const headTree = treeOf(repo, pull.head);
  const diffs = diffTrees(store, repo, baseTree, headTree);
  return sendJson(
    requestId,
    200,
    diffs.map((diff) => ({ filename: diff.path, status: diff.status, additions: diff.additions, deletions: diff.deletions, changes: diff.changes })),
  );
}

/** PUT /repos/{o}/{r}/pulls/{n}/merge: squash the pull onto its base branch. */
function pullsMerge(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  const number = Number.parseInt(args.segments[4] ?? '', 10);
  const pull = repoPull(repo, number);
  if (!pull) return notFound(requestId, 'Not Found');
  const parsed = jsonBody(args, requestId);
  if (parsed.error) return parsed.error;
  const input = (parsed.value ?? {}) as Record<string, unknown>;
  const method = typeof input.merge_method === 'string' ? input.merge_method : 'merge';
  const baseOid = resolveCommit(repo, pull.base);
  const headOid = resolveCommit(repo, pull.head);
  const merged = mergeTrees(store, repo, baseOid, headOid);
  if (merged.conflict) {
    return sendJson(requestId, 405, { message: 'Merge conflict', mergeable: false });
  }
  const baseBranch = pull.base;
  const baseTip = baseOid;
  const commitOid = putCommit(store, repo, baseBranch, merged.tree, baseTip ? [baseTip] : [], method === 'squash' ? `Merge pull request #${pull.number}` : `Merge pull request #${pull.number}`);
  pull.merged = true;
  pull.state = 'closed';
  pull.closedAt = store.nowIso;
  pull.updatedAt = store.nowIso;
  pull.mergeCommitSha = commitOid;
  return sendJson(requestId, 200, { sha: commitOid, merged: true, message: `Pull Request successfully merged` });
}

/** POST /repos/{o}/{r}/git/refs: create a branch ref at a commit. */
function refsPost(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  const parsed = jsonBody(args, requestId);
  if (parsed.error) return parsed.error;
  const input = (parsed.value ?? {}) as Record<string, unknown>;
  const ref = typeof input.ref === 'string' ? input.ref : '';
  const sha = typeof input.sha === 'string' ? input.sha : '';
  if (ref === '' || sha === '') return jsonError(requestId, 422, 'ref and sha are required');
  repo.refs.set(ref, sha);
  if (ref === `refs/heads/${repo.defaultBranch}`) repo.headOid = sha;
  repo.updatedAt = store.nowIso;
  bumpRepoCache(repo);
  return sendJson(requestId, 201, { ref, object: { sha, type: 'commit' } });
}

/** GET /repos/{o}/{r}/branches: list the heads. */
function branchesGet(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  const heads = [...repo.refs.entries()].filter(([ref]) => ref.startsWith('refs/heads/'));
  return sendJson(requestId, 200, heads.map(([ref, oid]) => branchJson(store, repo, ref, oid)));
}

/** GET /repos/{o}/{r}/commits: list commits reachable from a ref (or default). */
function commitsGet(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  const sha = args.query.get('sha') ?? args.query.get('ref') ?? null;
  const tip = resolveCommit(repo, sha) ?? repoHeadOid(repo);
  return sendJson(requestId, 200, commitList(store, repo, tip));
}

/** Route a REST request to its handler; unknown routes answer a JSON 404. */
export function handleRest(store: Store, args: RestArgs, requestId: string): RestResult {
  const segments = args.segments;
  const method = args.method.toUpperCase();
  const head = segments[0] ?? '';

  if (segments.length === 0 || (segments.length === 1 && head === '')) {
    return sendJson(requestId, 200, {
      current_user_url: '/user',
      repository_url: '/repos/{owner}/{repo}',
      emojis_url: '/emojis',
      rate_limit_url: '/rate_limit',
    });
  }
  if (head === 'meta') return sendJson(requestId, 200, { installed_version: 'makefun github-core-clone-01' });
  if (head === 'rate_limit') return sendJson(requestId, 200, { resources: { core: { limit: 5000, remaining: 5000, reset: store.epochSec } } });
  if (head === 'user') {
    if (segments[1] === 'repos' && segments.length === 2) {
      if (method === 'POST') return createRepo(store, args, requestId);
      if (method === 'GET') return listUserRepos(store, args, requestId);
    }
    return sendJson(requestId, 200, userJson(store.viewer));
  }
  if (head === 'repos') {
    const owner = segments[1] ?? '';
    const name = segments[2] ?? '';
    const sub = segments[3];
    if (sub === 'contents') {
      if (method === 'GET') return contentsGet(store, args, requestId);
      if (method === 'PUT') return contentsPut(store, args, requestId);
      if (method === 'DELETE') return contentsDelete(store, args, requestId);
    }
    if (sub === 'commits' && segments.length === 4 && method === 'GET') return commitsGet(store, args, requestId);
    if (sub === 'branches' && segments.length === 4 && method === 'GET') return branchesGet(store, args, requestId);
    if (sub === 'labels' && segments.length === 4 && method === 'POST') return labelsPost(store, args, requestId);
    if (sub === 'git' && segments[4] === 'refs' && method === 'POST') return refsPost(store, args, requestId);
    if (sub === 'issues') {
      if (segments.length === 4) {
        if (method === 'GET') return issuesList(store, args, requestId);
        if (method === 'POST') return issuesPost(store, args, requestId);
      }
      if (segments.length === 5) {
        if (method === 'GET') return issuesGetOne(store, args, requestId);
        if (method === 'PATCH') return issuesPatch(store, args, requestId);
      }
      if (segments.length === 6 && segments[5] === 'comments') {
        if (method === 'GET') return commentsList(store, args, requestId);
        if (method === 'POST') return commentsPost(store, args, requestId);
      }
    }
    if (sub === 'pulls') {
      if (segments.length === 4) {
        if (method === 'GET') return pullsList(store, args, requestId);
        if (method === 'POST') return pullsPost(store, args, requestId);
      }
      if (segments.length === 5 && method === 'GET') return pullsGetOne(store, args, requestId);
      if (segments.length === 6) {
        if (segments[5] === 'files' && method === 'GET') return pullsFiles(store, args, requestId);
        if (segments[5] === 'merge' && method === 'PUT') return pullsMerge(store, args, requestId);
      }
    }
    if (segments.length === 3) {
      if (method === 'GET') return getRepo(store, args, requestId);
      if (method === 'PATCH') return repoPatch(store, args, requestId);
      if (method === 'DELETE') return repoDelete(store, args, requestId);
    }
  }
  return notFound(requestId, 'Not Found');
}

/** PATCH /repos/{o}/{r}: update a repository's description (and other fields). */
function repoPatch(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  const parsed = jsonBody(args, requestId);
  if (parsed.error) return parsed.error;
  const input = (parsed.value ?? {}) as Record<string, unknown>;
  if (typeof input.description === 'string') repo.description = input.description;
  if (typeof input.name === 'string' && input.name !== '') {
    repo.refs.clear();
    repo.name = input.name;
    repo.fullName = `${repo.owner}/${repo.name}`;
    store.repos.delete(`${owner}/${name}`);
    store.repos.set(repo.fullName, repo);
  }
  repo.updatedAt = store.nowIso;
  bumpRepoCache(repo);
  return sendJson(requestId, 200, repoJson(store, repo));
}

/** DELETE /repos/{o}/{r}: remove a repository and answer 204. */
function repoDelete(store: Store, args: RestArgs, requestId: string): RestResult {
  const owner = args.segments[1] ?? '';
  const name = args.segments[2] ?? '';
  const repo = storeRepo(store, owner, name);
  if (!repo) return notFound(requestId, 'Not Found');
  store.repos.delete(repo.fullName);
  return { status: 204, headers: { 'content-type': JSON_TYPE, 'x-github-request-id': requestId, 'x-oauth-scopes': 'repo' }, body: '', contentType: JSON_TYPE };
}