import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = `${type} ${body.length}\u0000`;
  const digest = createHash('sha1');
  digest.update(header);
  digest.update(body);
  return digest.digest('hex');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}
export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}
export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    const nul = buffer.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > buffer.length) throw new Error('bad tree');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = a.mode === '40000' ? `${a.name}/` : a.name;
  const right = b.mode === '40000' ? `${b.name}/` : b.name;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  let size = 0;
  for (const entry of sorted) {
    const modeB = Buffer.from(`${entry.mode} `, 'ascii');
    const nameB = Buffer.from(entry.name, 'utf8');
    const oidB = Buffer.from(entry.oid, 'hex');
    size += modeB.length + nameB.length + 21;
    parts.push(modeB, nameB, Buffer.alloc(1), oidB);
  }
  return Buffer.concat(parts, size);
}

export interface CommitInput {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}
export function buildCommit(input: CommitInput): Buffer {
  const lines: string[] = [
    `tree ${input.tree}`,
    `author ${input.author} ${input.timestamp} +0000`,
    `committer ${input.committer} ${input.timestamp} +0000`,
  ];
  for (const parent of input.parents ?? []) lines.push(`parent ${parent}`);
  const msg = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${msg}`, 'utf8');
}

export interface TagInput {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger: string;
  timestamp: number;
}
export function buildTag(input: TagInput): Buffer {
  const msg = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(
    `object ${input.object}\ntype ${input.type}\ntag ${input.tag}\ntagger ${input.tagger} ${input.timestamp} +0000\n\n${msg}`,
    'utf8'
  );
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const text = buffer.toString('utf8');
  const sep = text.indexOf('\n\n');
  const head = sep < 0 ? text : text.slice(0, sep);
  const message = sep < 0 ? '' : text.slice(sep + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const text = buffer.toString('utf8');
  const sep = text.indexOf('\n\n');
  const head = sep < 0 ? text : text.slice(0, sep);
  const message = sep < 0 ? '' : text.slice(sep + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5) as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export interface Label {
  name: string;
  color: string;
  description: string;
}
export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}
export interface Comment {
  id: number;
  user: User;
  body: string;
  createdAt: string;
  updatedAt: string;
}
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  user: User;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}
export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  user: User;
  state: 'open' | 'closed' | 'merged';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  merged: boolean;
  mergeable: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
}

export interface Repo {
  id: number;
  owner: User;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  size: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  issueByNumber: Map<number, Issue>;
  pullByNumber: Map<number, Pull>;
  headOid: string;
  depth1Pack: Buffer | null;
  cacheRev: number;
}

export function bumpRepoCache(repo: Repo): void {
  repo.cacheRev += 1;
  repo.depth1Pack = null;
}

export interface Store {
  nextUserId: number;
  nextRepoId: number;
  nextIssueId: number;
  nextPullId: number;
  nextCommentId: number;
  users: Map<string, User>;
  repos: Map<string, Repo>;
  viewer: User;
  epochSec: number;
  nowIso: string;
}

export function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString();
}