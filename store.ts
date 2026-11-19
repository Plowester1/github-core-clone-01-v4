import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  size: number;
  data: Buffer;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  const full = Buffer.concat([header, data]);
  return createHash('sha1').update(full).digest('hex');
}

export interface TreeEntry {
  name: string;
  mode: number;
  oid: string;
}

export function compareTreeNames(a: string, b: string): number {
  let i = 0;
  const la = a.length;
  const lb = b.length;
  while (i < la && i < lb) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca - cb;
    i += 1;
  }
  if (la === lb) return 0;
  if (i === la) return -1;
  return 1;
}

export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  const decorated = entries.map((e) => {
    const isDir = e.mode === 0o40000;
    return { entry: e, key: isDir ? `${e.name}/` : e.name };
  });
  decorated.sort((a, b) => {
    const k = compareTreeNames(a.key, b.key);
    if (k !== 0) return k;
    return a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0;
  });
  return decorated.map((d) => d.entry);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = sortTreeEntries(entries);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    const mode = e.mode.toString(8);
    parts.push(Buffer.from(`${mode} ${e.name}`, 'utf8'));
    parts.push(Buffer.from([0x00]));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const spaceIdx = data.indexOf(0x20, pos);
    if (spaceIdx < 0) break;
    const mode = parseInt(data.slice(pos, spaceIdx).toString('utf8'), 8);
    const nulIdx = data.indexOf(0x00, spaceIdx);
    if (nulIdx < 0) break;
    const name = data.slice(spaceIdx + 1, nulIdx).toString('utf8');
    const oid = data.slice(nulIdx + 1, nulIdx + 21).toString('hex');
    entries.push({ name, mode, oid });
    pos = nulIdx + 21;
  }
  return entries;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd < 0 ? text : text.slice(0, headerEnd);
  const message = headerEnd < 0 ? '' : text.slice(headerEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) {
      tree = line.slice(5);
    } else if (line.startsWith('parent ')) {
      parents.push(line.slice(7));
    } else if (line.startsWith('author ')) {
      author = line.slice(7);
    } else if (line.startsWith('committer ')) {
      committer = line.slice(10);
    }
  }
  return { tree, parents, author, committer, message };
}

export interface CommitInput {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function buildCommit(input: CommitInput): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const p of input.parents) lines.push(`parent ${p}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  let msg = input.message;
  if (!msg.endsWith('\n')) msg += '\n';
  return Buffer.from(`${lines.join('\n')}\n\n${msg}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd < 0 ? text : text.slice(0, headerEnd);
  const message = headerEnd < 0 ? '' : text.slice(headerEnd + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) {
      object = line.slice(7);
    } else if (line.startsWith('type ')) {
      type = line.slice(5);
    } else if (line.startsWith('tag ')) {
      tag = line.slice(4);
    } else if (line.startsWith('tagger ')) {
      tagger = line.slice(7);
    }
  }
  return { object, type, tag, tagger, message };
}

export interface TagInput {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function buildTag(input: TagInput): Buffer {
  const lines = [
    `object ${input.object}`,
    `type ${input.type}`,
    `tag ${input.tag}`,
    `tagger ${input.tagger}`,
  ];
  let msg = input.message;
  if (!msg.endsWith('\n')) msg += '\n';
  return Buffer.from(`${lines.join('\n')}\n\n${msg}`, 'utf8');
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
  createdAt: string;
}

export interface Comment {
  id: number;
  user: User;
  createdAt: string;
  updatedAt: string;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  user: User;
  title: string;
  body: string;
  state: string;
  labels: Label[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  user: User;
  title: string;
  body: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
  head: string;
  base: string;
}

export function bumpRepoCache(repo: Repo): void {
  repo.cacheRev += 1;
  repo.depth1Pack = null;
}

export function isoOf(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

export const EPOC_SEC = 1_700_000_000;

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

export interface Repo {
  id: number;
  owner: string;
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
  labels: Label[];
  issues: Issue[];
  pulls: Pull[];
  issueByNumber: Map<number, Issue>;
  pullByNumber: Map<number, Pull>;
  headOid: string | null;
  depth1Pack: Buffer | null;
  cacheRev: number;
}

export const EPOCH_SEC = 1_700_000_000;

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'Ada Iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export function makeViewer(): User {
  const createdAt = isoOf(EPOCH_SEC);
  return { id: 1, login: VIEWER_LOGIN, name: VIEWER_NAME, email: VIEWER_EMAIL, createdAt };
}

export class Store {
  nextUserId = 2;
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;
  users = new Map<string, User>();
  repos = new Map<string, Repo>();
  viewer: User;
  epochSec = EPOCH_SEC;
  nowIso: string;

  constructor(nowIso?: string) {
    this.viewer = makeViewer();
    this.users.set(this.viewer.login, this.viewer);
    this.nowIso = nowIso ?? isoOf(EPOCH_SEC);
  }

  userFor(token: string | undefined): User {
    const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    if (expected !== '' && token !== expected) {
      return this.viewer;
    }
    if (token && this.users.has(token)) return this.users.get(token)!;
    return this.viewer;
  }

  ensureUser(token: string | undefined): User {
    const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    if (expected !== '' && token !== expected) return this.viewer;
    return this.viewer;
  }

  createRepo(owner: string, name: string, opts: {
    description?: string;
    isPrivate?: boolean;
    defaultBranch?: string;
  } = {}): Repo {
    const ts = this.nowIso;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description: opts.description ?? '',
      private: opts.isPrivate ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      createdAt: ts,
      updatedAt: ts,
      pushedAt: ts,
      size: 0,
      objects: new Map(),
      refs: new Map(),
      labels: [],
      issues: [],
      pulls: [],
      issueByNumber: new Map(),
      pullByNumber: new Map(),
      headOid: null,
      depth1Pack: null,
      cacheRev: 0,
    };
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  getRepo(fullName: string): Repo | undefined {
    return this.repos.get(fullName);
  }

  findUser(login: string): User | undefined {
    for (const u of this.users.values()) if (u.login === login) return u;
    return undefined;
  }
}

export const store = new Store();