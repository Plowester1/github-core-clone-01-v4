import {
  Store,
  bumpRepoCache,
  isoOf,
} from './store.ts';
import { repoHeadOid, collectReachable } from './git.ts';

export const GRAPHQL_PATH = '/api/graphql';

export interface GraphQLArgs {
  method: string;
  body: string;
  token: string;
  origin: string;
  store: Store;
}
export const GraphQLArgs: unique symbol = Symbol('GraphQLArgs');

type TokenType = 'name' | 'string' | 'int' | 'punct' | 'var' | 'eof';

interface Token {
  type: TokenType;
  value: string;
  start: number;
}

function isNameStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}
function isNamePart(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}
function isDigit(c: string): boolean {
  return /[0-9]/.test(c);
}
function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\uFEFF' || c === '\u2028' || c === '\u2029';
}

function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (isSpace(c)) { i++; continue; }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      let val = '';
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          i++;
          const esc = src[i];
          switch (esc) {
            case 'n': val += '\n'; break;
            case 'r': val += '\r'; break;
            case 't': val += '\t'; break;
            case 'b': val += '\b'; break;
            case 'f': val += '\f'; break;
            case '"': val += '"'; break;
            case "'": val += "'"; break;
            case '/': val += '/'; break;
            case '\\': val += '\\'; break;
            case 'u': {
              const hex = src.slice(i + 1, i + 5);
              val += String.fromCharCode(parseInt(hex, 16));
              i += 4;
              break;
            }
            default: val += esc;
          }
          i++;
        } else {
          val += src[i];
          i++;
        }
      }
      i++;
      toks.push({ type: 'string', value: val, start: i });
      continue;
    }
    if (c === '$') {
      i++;
      let val = '';
      while (i < n && isNamePart(src[i])) { val += src[i]; i++; }
      toks.push({ type: 'var', value: val, start: i });
      continue;
    }
    if (isDigit(c) || (c === '-' && isDigit(src[i + 1]))) {
      let val = '';
      if (c === '-') { val += '-'; i++; }
      while (i < n && isDigit(src[i])) { val += src[i]; i++; }
      if (src[i] === '.') {
        val += '.';
        i++;
        while (i < n && isDigit(src[i])) { val += src[i]; i++; }
      }
      toks.push({ type: 'int', value: val, start: i });
      continue;
    }
    if (isNameStart(c)) {
      let val = '';
      while (i < n && isNamePart(src[i])) { val += src[i]; i++; }
      toks.push({ type: 'name', value: val, start: i });
      continue;
    }
    toks.push({ type: 'punct', value: c, start: i });
    i++;
  }
  toks.push({ type: 'eof', value: '', start: n });
  return toks;
}

interface Parser {
  toks: Token[];
  pos: number;
  vars: Map<string, unknown>;
}

function peek(p: Parser): Token {
  return p.toks[p.pos];
}
function next(p: Parser): Token {
  return p.toks[p.pos++];
}
function expectPunct(p: Parser, v: string): void {
  const t = next(p);
  if (t.type !== 'punct' || t.value !== v) throw new Error('expected "' + v + '"');
}
function expectName(p: Parser, v: string): void {
  const t = next(p);
  if (t.type !== 'name' || t.value !== v) throw new Error('expected "' + v + '"');
}

function parseValue(p: Parser): unknown {
  const t = next(p);
  if (t.type === 'string') return t.value;
  if (t.type === 'int') {
    const s = t.value;
    if (s.includes('.')) return parseFloat(s);
    return parseInt(s, 10);
  }
  if (t.type === 'var') {
    const name = t.value;
    if (!p.vars.has(name)) throw new Error('no variable $' + name);
    return p.vars.get(name);
  }
  if (t.type === 'name') {
    if (t.value === 'true') return true;
    if (t.value === 'false') return false;
    if (t.value === 'null') return null;
    throw new Error('unexpected name ' + t.value);
  }
  if (t.type === 'punct' && t.value === '[') {
    const arr: unknown[] = [];
    if (peek(p).type === 'punct' && peek(p).value === ']') { next(p); return arr; }
    while (true) {
      arr.push(parseValue(p));
      if (peek(p).type === 'punct' && peek(p).value === ']') { next(p); break; }
      expectPunct(p, ',');
    }
    return arr;
  }
  if (t.type === 'punct' && t.value === '{') {
    const obj: Record<string, unknown> = {};
    while (true) {
      const key = next(p);
      if (key.type === 'string') {
        expectPunct(p, ':');
        obj[key.value] = parseValue(p);
      } else if (key.type === 'punct' && key.value === '}') {
        break;
      } else {
        throw new Error('bad object');
      }
    }
    return obj;
  }
  throw new Error('bad value');
}

interface FieldNode {
  name: string;
  alias?: string;
  args: Record<string, unknown>;
  sub: FieldNode[] | null;
}

function parseField(p: Parser): FieldNode {
  let name = '';
  let alias: string | undefined;
  const first = next(p);
  if (first.type !== 'name') throw new Error('expected field name');
  name = first.value;
  if (peek(p).type === 'punct' && peek(p).value === ':') {
    next(p);
    alias = name;
    const second = next(p);
    if (second.type !== 'name') throw new Error('expected field name');
    name = second.value;
  }
  const args: Record<string, unknown> = {};
  if (peek(p).type === 'punct' && peek(p).value === '(') {
    next(p);
    while (true) {
      const an = next(p);
      if (an.type === 'punct' && an.value === ')') break;
      if (an.type !== 'name') throw new Error('expected arg name');
      expectPunct(p, ':');
      args[an.value] = parseValue(p);
      if (peek(p).type === 'punct' && peek(p).value === ')') { next(p); break; }
      expectPunct(p, ',');
    }
  }
  while (peek(p).type === 'punct' && peek(p).value === '@') {
    next(p);
    const dn = next(p);
    if (dn.type === 'name' && (dn.value === 'skip' || dn.value === 'include')) {
      if (peek(p).type === 'punct' && peek(p).value === '(') {
        next(p);
        while (true) {
          const an = next(p);
          if (an.type === 'punct' && an.value === ')') break;
          if (an.type !== 'name') throw new Error('expected dir arg');
          expectPunct(p, ':');
          args[an.value] = parseValue(p);
          if (peek(p).type === 'punct' && peek(p).value === ')') { next(p); break; }
          expectPunct(p, ',');
        }
      }
    }
  }
  let sub: FieldNode[] | null = null;
  if (peek(p).type === 'punct' && peek(p).value === '{') {
    sub = parseSelectionSet(p);
  }
  return { name, alias, args, sub };
}

function parseSelectionSet(p: Parser): FieldNode[] {
  expectPunct(p, '{');
  const fields: FieldNode[] = [];
  while (true) {
    if (peek(p).type === 'punct' && peek(p).value === '}') { next(p); break; }
    if (peek(p).type === 'punct' && peek(p).value === '...') {
      next(p);
      if (peek(p).type === 'punct' && peek(p).value === '[') {
        next(p);
        while (true) {
          const frag = next(p);
          if (frag.type === 'punct' && frag.value === ']') break;
          const spread = parseSelectionSet(p);
          const v = validateFrag(p, frag.value, spread);
          for (const f of v) fields.push(f);
          if (peek(p).type === 'punct' && peek(p).value === ']') { next(p); break; }
          expectPunct(p, ',');
        }
      } else {
        const frag = next(p);
        if (frag.type !== 'name') throw new Error('expected fragment name');
        const spread = parseSelectionSet(p);
        const v = validateFrag(p, frag.value, spread);
        for (const f of v) fields.push(f);
      }
      continue;
    }
    fields.push(parseField(p));
  }
  return fields;
}

interface Fragment {
  name: string;
  type: string;
  fields: FieldNode[];
}

const fragments: Fragment[] = [];

function validateFrag(p: Parser, name: string, spread: FieldNode[]): FieldNode[] {
  const frag = fragments.find((f) => f.name === name);
  if (!frag) throw new Error('no fragment ' + name);
  return frag.fields;
}

interface OpNode {
  name: string;
  op: string;
  vars: Map<string, unknown>;
  fields: FieldNode[];
}

function parseDocument(src: string, variables: Map<string, unknown>): OpNode {
  const toks = tokenize(src);
  const p: Parser = { toks, pos: 0, vars: variables };
  while (peek(p).type === 'name' && peek(p).value === 'query') {
    next(p);
    const on = next(p);
    if (on.type !== 'name') throw new Error('expected operation name');
    if (on.value === 'query' || on.value === 'mutation' || on.value === 'subscription') {
      // anonymous op: treat 'query' as already consumed - back up
      p.pos--;
      break;
    }
    if (peek(p).type === 'punct' && peek(p).value === '(') {
      next(p);
      while (true) {
        if (peek(p).type === 'punct' && peek(p).value === ')') { next(p); break; }
        next(p); // skip $name or type - permissive
        if (peek(p).type === 'punct' && peek(p).value === ':') {
          next(p);
          next(p);
        }
        if (peek(p).type === 'punct' && peek(p).value === '=') {
          next(p);
          parseValue(p);
        }
      }
    }
    const fields = parseSelectionSet(p);
    return { name: on.value, op: 'query', vars: variables, fields };
  }
  const opTok = next(p);
  let op = 'query';
  if (opTok.type === 'name') {
    if (opTok.value === 'query' || opTok.value === 'mutation') op = opTok.value;
  }
  if (peek(p).type === 'punct' && peek(p).value === '{') {
    const fields = parseSelectionSet(p);
    return { name: '', op, vars: variables, fields };
  }
  const on = next(p);
  if (on.type !== 'name') throw new Error('expected operation name');
  if (peek(p).type === 'punct' && peek(p).value === '(') {
    next(p);
    while (true) {
      if (peek(p).type === 'punct' && peek(p).value === ')') { next(p); break; }
      next(p);
      if (peek(p).type === 'punct' && peek(p).value === ':') {
        next(p);
        next(p);
      }
      if (peek(p).type === 'punct' && peek(p).value === '=') {
        next(p);
        parseValue(p);
      }
    }
  }
  const fields = parseSelectionSet(p);
  return { name: on.value, op, vars: variables, fields };
}

// ---------- execution helpers ----------

type StoreType = Store;

function repoById(store: Store, id: string): any {
  for (const r of store.repos.values()) {
    if (String(r.id) === id) return r;
  }
  return undefined;
}

function connectionPage(all: any[], first: number | null, after: string | null, resolver?: (it: any) => any): any {
  let list = all;
  if (after) {
    const cursor = after;
    const idx = list.findIndex((it: any) => String(it.id) === String(cursor));
    if (idx >= 0) list = list.slice(idx + 1);
  }
  const page = first != null && first >= 0 ? list.slice(0, first) : list;
  const startCursor = page.length ? String(page[0].id) : null;
  const endCursor = page.length ? String(page[page.length - 1].id) : null;
  const hasNextPage = first != null && first >= 0 && list.length > first;
  const hasPrevPage = false;
  const nodes = page.map((it: any) => (resolver ? resolver(it) : it));
  return {
    pageInfo: { startCursor, endCursor, hasNextPage, hasPrevPage },
    nodes,
    edges: nodes.map((it: any) => ({ node: it, cursor: String(it.id) })),
  };
}

function resolveUser(u: any): any {
  if (!u) return null;
  return {
    __gqlType: 'User',
    id: String(u.id),
    login: u.login,
    name: u.name,
    email: u.email,
    createdAt: u.createdAt,
  };
}

function resolveLabel(l: any): any {
  if (!l) return null;
  return {
    __gqlType: 'Label',
    id: String(l.id),
    name: l.name,
    color: l.color,
    description: l.description,
  };
}

function resolveComment(c: any): any {
  if (!c) return null;
  return {
    __gqlType: 'Comment',
    id: String(c.id),
    user: resolveUser(c.user),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    body: c.body,
    author: resolveUser(c.user),
  };
}

function resolveIssue(issue: any): any {
  if (!issue) return null;
  return {
    __gqlType: 'Issue',
    id: String(issue.id),
    number: issue.number,
    author: resolveUser(issue.user),
    user: resolveUser(issue.user),
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    labels: (issue.labels || []).map(resolveLabel),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    comments: connectionPage(issue.comments || [], null, null, resolveComment),
  };
}

function resolvePull(pull: any): any {
  if (!pull) return null;
  return {
    __gqlType: 'PullRequest',
    id: String(pull.id),
    number: pull.number,
    author: resolveUser(pull.user),
    user: resolveUser(pull.user),
    title: pull.title,
    body: pull.body,
    state: pull.state.toUpperCase(),
    labels: (pull.labels || []).map(resolveLabel),
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    closedAt: pull.closedAt,
    headRefName: pull.head,
    baseRefName: pull.base,
    head: pull.head,
    base: pull.base,
    comments: connectionPage(pull.comments || [], null, null, resolveComment),
  };
}

function resolveRepo(repo: any): any {
  if (!repo) return null;
  return {
    __gqlType: 'Repository',
    name: repo.name,
    fullName: repo.fullName,
    description: repo.description,
    isPrivate: repo.private,
    private: repo.private,
    defaultBranchRef: repo.defaultBranch ? { __gqlType: 'Ref', name: repo.defaultBranch, oid: repo.headOid } : null,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    pushedAt: repo.pushedAt,
    size: repo.size,
    databaseId: repo.id,
  };
}

function repoHeadName(repo: any): string | null {
  const refs = repo.refs;
  if (refs && refs.size) {
    for (const ref of refs.keys()) {
      if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
    }
  }
  return repo.defaultBranch || null;
}

// ---------- resolver dispatch ----------

function resolveField(field: FieldNode, ctx: { store: Store; parent: any; parentType: string }): any {
  const { store, parent, parentType } = ctx;
  const name = field.name; 

  if (field.sub === null) {
    // leaf field
    return resolveLeaf(parent, parentType, field);
  }

  // object field
  switch (parentType) {
    case 'Query': return resolveQueryField(field, store);
    case 'Mutation': return resolveMutationField(field, store);
    case 'Repository': {
      const repo = parent;
      switch (name) {
        case 'owner': return { login: repo.owner };
        case 'issues': {
          const first = field.args.first != null ? Number(field.args.first) : null;
          const after = field.args.after != null ? String(field.args.after) : null;
          const states = field.args.states;
          let list = repo.issues || [];
          if (Array.isArray(states)) {
            list = list.filter((i: any) => states.some((s: any) => String(s).toUpperCase() === i.state.toUpperCase()));
          }
          return { ...connectionPage(list, first, after, resolveIssue), repo };
        }
        case 'pullRequests': {
          const first = field.args.first != null ? Number(field.args.first) : null;
          const after = field.args.after != null ? String(field.args.after) : null;
          const states = field.args.states;
          let list = repo.pulls || [];
          if (Array.isArray(states)) {
            list = list.filter((p: any) => states.some((s: any) => String(s).toUpperCase() === p.state.toUpperCase()));
          }
          return { ...connectionPage(list, first, after, resolvePull), repo };
        }
        case 'refs':
        case 'branches': {
          const first = field.args.first != null ? Number(field.args.first) : null;
          const after = field.args.after != null ? String(field.args.after) : null;
          const names: any[] = [];
          if (repo.refs && repo.refs.size) {
            for (const ref of repo.refs.keys()) {
              if (ref.startsWith('refs/heads/')) {
                names.push({ __gqlType: 'Ref', name: ref.slice('refs/heads/'.length), oid: repo.refs.get(ref) });
              }
            }
          } else if (repo.defaultBranch) {
            names.push({ __gqlType: 'Ref', name: repo.defaultBranch, oid: repo.headOid });
          }
          const page = connectionPage(names, first, after);
          return { ...page, repo };
        }
        default:
          throw new Error('unknown Repository field ' + name);
      }
    }
    case 'Issue': return resolveSubObject(parent, name, 'Issue');
    case 'PullRequest': return resolveSubObject(parent, name, 'PullRequest');
    case 'User': return resolveSubObject(parent, name, 'User');
    case 'Label': return resolveSubObject(parent, name, 'Label');
    case 'Comment': return resolveSubObject(parent, name, 'Comment');
    case 'RepositoryConnection':
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'RefConnection':
    case 'CommentConnection':
    case 'SearchResultItemConnection': {
      return resolveConnectionField(parent, name!, field);
    }
    case 'PageInfo': return resolveLeaf(parent, 'PageInfo', field);
    default:
      throw new Error('unknown type ' + parentType);
  }
}

function resolveConnectionField(parent: any, name: string, field: FieldNode): any {
  if (name === 'nodes') return (parent.nodes || []).map((n: any) => n);
  if (name === 'edges') return (parent.edges || []).map((e: any) => e);
  if (name === 'pageInfo') return parent.pageInfo;
  if (name === 'totalCount') return parent.totalCount != null ? parent.totalCount : (parent.nodes ? parent.nodes.length : 0);
  if (name === 'issueCount') return parent.issueCount != null ? parent.issueCount : 0;
  if (name === 'repositoryCount') return parent.repositoryCount != null ? parent.repositoryCount : 0;
  if (name === 'userCount') return parent.userCount != null ? parent.userCount : 0;
  throw new Error('unknown connection field ' + name);
}

function resolveLeaf(parent: any, type: string, field: FieldNode): any {
  const name = field.name;
  if (field.alias) { /* alias handled by caller */ }
  if (parent == null) return null;
  switch (type) {
    case 'Query':
      if (name === '__typename') return 'Query';
      break;
    case 'Mutation':
      if (name === '__typename') return 'Mutation';
      break;
    case 'Repository':
      if (name === '__typename') return 'Repository';
      return parent[name] !== undefined ? parent[name] : parent[field.alias || name];
    case 'Issue':
      if (name === '__typename') return 'Issue';
      return parent[name];
    case 'PullRequest':
      if (name === '__typename') return 'PullRequest';
      return parent[name];
    case 'User':
      if (name === '__typename') return 'User';
      return parent[name];
    case 'Label':
      if (name === '__typename') return 'Label';
      return parent[name];
    case 'Comment':
      if (name === '__typename') return 'Comment';
      return parent[name];
    case 'PageInfo':
      if (name === '__typename') return 'PageInfo';
      return parent[name];
    default:
      return parent[name];
  }
  return null;
}

function resolveSubObject(parent: any, name: string, type: string): any {
  if (name === '__typename') return type;
  return parent[name];
}

function resolveQueryField(field: FieldNode, store: Store): any {
  const name = field.name;
  if (name === '__typename') return 'Query';
  switch (name) {
    case 'viewer':
      return { login: store.viewer.login };
    case 'repository': {
      const owner = String(field.args.owner || '');
      const repoName = String(field.args.name || '');
      const full = owner + '/' + repoName;
      return resolveRepo(store.getRepo(full));
    }
    case 'node': {
      const id = String(field.args.id || '');
      const r = repoById(store, id);
      if (r) return resolveRepo(r);
      for (const repo of store.repos.values()) {
        for (const issue of repo.issues || []) {
          if (String(issue.id) === id) return resolveIssue(issue);
        }
        for (const pull of repo.pulls || []) {
          if (String(pull.id) === id) return resolvePull(pull);
        }
      }
      return null;
    }
    case 'search': {
      const query = String(field.args.query || '');
      const first = field.args.first != null ? Number(field.args.first) : null;
      const after = field.args.after != null ? String(field.args.after) : null;
      const ql = query.toLowerCase();
      let issues: any[] = [];
      let pulls: any[] = [];
      let repos: any[] = [];
      for (const repo of store.repos.values()) {
        for (const issue of repo.issues || []) {
          if ((issue.title + ' ' + issue.body).toLowerCase().includes(ql)) issues.push(issue);
        }
        for (const pull of repo.pulls || []) {
          if ((pull.title + ' ' + pull.body).toLowerCase().includes(ql)) pulls.push(pull);
        }
        if ((repo.fullName + ' ' + (repo.description || '')).toLowerCase().includes(ql)) repos.push(repo);
      }
      let nodes: any[] = [];
      let total = 0;
      if (query.startsWith('repo:')) {
        nodes = repos.map(resolveRepo);
        total = nodes.length;
      } else if (query.startsWith('type:pr') || query.toLowerCase().includes('is:pr')) {
        nodes = pulls.map(resolvePull);
        total = nodes.length;
      } else if (query.startsWith('type:issue') || query.toLowerCase().includes('is:issue')) {
        nodes = issues.map(resolveIssue);
        total = nodes.length;
      } else if (query.toLowerCase().includes('is:open')) {
        const open = [...issues, ...pulls].filter((i: any) => i.state === 'open');
        nodes = open.map((i: any) => resolveIssue(i));
        total = nodes.length;
      } else if (query.toLowerCase().includes('is:closed')) {
        const closed = [...issues, ...pulls].filter((i: any) => i.state === 'closed');
        nodes = closed.map((i: any) => resolveIssue(i));
        total = nodes.length;
      } else {
        nodes = [...issues, ...pulls].map((i: any) => resolveIssue(i));
        total = nodes.length;
      }
      let page = nodes;
      if (after) {
        const idx = nodes.findIndex((n: any) => String(n.id) === String(after));
        if (idx >= 0) page = nodes.slice(idx + 1);
      }
      if (first != null && first >= 0) page = page.slice(0, first);
      const startCursor = page.length ? String(page[0].id) : null;
      const endCursor = page.length ? String(page[page.length - 1].id) : null;
      const hasNextPage = first != null && first >= 0 ? nodes.length > page.length : false;
      return { nodes: page, totalCount: total, issueCount: issues.length, repositoryCount: repos.length, userCount: 0, pageInfo: { startCursor, endCursor, hasNextPage, hasPrevPage: false } };
    }
    case 'issues':
    case 'pullRequests': {
      const first = field.args.first != null ? Number(field.args.first) : null;
      const after = field.args.after != null ? String(field.args.after) : null;
      const list: any[] = [];
      for (const repo of store.repos.values()) {
        if (name === 'issues') list.push(...(repo.issues || []));
        else list.push(...(repo.pulls || []));
      }
      const mapped = name === 'issues' ? list.map(resolveIssue) : list.map(resolvePull);
      const page = connectionPage(mapped, first, after);
      return { ...page, totalCount: mapped.length };
    }
    case '__schema': return resolveSchema(field, store);
    case '__type': return resolveType(field.args.name ? String(field.args.name) : '', field);
    default:
      throw new Error('unknown query field ' + name);
  }
}

function resolveMutationField(field: FieldNode, store: Store): any {
  const name = field.name;
  if (name === '__typename') return 'Mutation';
  const input = (field.args.input || {}) as any;
  switch (name) {
    case 'createIssue': {
      const repoFull = String(input.repositoryId || input.repoId || '');
      let repo = repoById(store, repoFull);
      if (!repo) repo = store.getRepo(repoFull);
      if (!repo) throw new Error('repository not found');
      const issue = {
        id: store.nextIssueId++,
        number: repo.issues.length + 1,
        user: store.viewer,
        title: String(input.title || ''),
        body: String(input.body || ''),
        state: 'open',
        labels: [],
        createdAt: store.nowIso,
        updatedAt: store.nowIso,
        closedAt: null,
        comments: [],
      };
      repo.issues.push(issue);
      repo.issueByNumber.set(issue.number, issue);
      bumpRepoCache(repo);
      return { issue: resolveIssue(issue), repository: resolveRepo(repo) };
    }
    case 'createPullRequest': {
      const repoFull = String(input.repositoryId || input.repoId || '');
      let repo = repoById(store, repoFull);
      if (!repo) repo = store.getRepo(repoFull);
      if (!repo) throw new Error('repository not found');
      const pull = {
        id: store.nextPullId++,
        number: repo.pulls.length + 1,
        user: store.viewer,
        title: String(input.title || ''),
        body: String(input.body || ''),
        state: 'open',
        labels: [],
        createdAt: store.nowIso,
        updatedAt: store.nowIso,
        closedAt: null,
        comments: [],
        head: String(input.headRefName || input.head || ''),
        base: String(input.baseRefName || input.base || ''),
      };
      repo.pulls.push(pull);
      repo.pullByNumber.set(pull.number, pull);
      bumpRepoCache(repo);
      return { pullRequest: resolvePull(pull), repository: resolveRepo(repo) };
    }
    case 'closeIssue': {
      const result = mutateIssueState(store, input, 'closed');
      return result;
    }
    case 'reopenIssue': {
      const result = mutateIssueState(store, input, 'open');
      return result;
    }
    case 'addComment': {
      const id = String(input.issueId || input.subjectId || '');
      let found: any = null;
      let repo: any = null;
      for (const r of store.repos.values()) {
        for (const issue of r.issues || []) {
          if (String(issue.id) === id) { found = issue; repo = r; break; }
        }
        if (found) break;
        for (const pull of r.pulls || []) {
          if (String(pull.id) === id) { found = pull; repo = r; break; }
        }
        if (found) break;
      }
      if (!found) throw new Error('subject not found');
      const comment = {
        id: store.nextCommentId++,
        user: store.viewer,
        createdAt: store.nowIso,
        updatedAt: store.nowIso,
        body: String(input.body || ''),
      };
      found.comments.push(comment);
      bumpRepoCache(repo);
      return { comment: resolveComment(comment), subject: resolveIssue(found) };
    }
    default:
      throw new Error('unknown mutation field ' + name);
  }
}

function mutateIssueState(store: Store, input: any, state: string): any {
  const id = String(input.issueId || input.id || '');
  let found: any = null;
  let repo: any = null;
  for (const r of store.repos.values()) {
    for (const issue of r.issues || []) {
      if (String(issue.id) === id || String(issue.number) === id) { found = issue; repo = r; break; }
    }
    if (found) break;
  }
  if (!found) throw new Error('issue not found');
  found.state = state;
  found.updatedAt = store.nowIso;
  if (state === 'closed') found.closedAt = store.nowIso;
  else found.closedAt = null;
  bumpRepoCache(repo);
  return { issue: resolveIssue(found) };
}

// ---------- introspection ----------

const TYPES = [
  'Query', 'Mutation', 'Repository', 'User', 'Issue', 'PullRequest', 'Label',
  'Comment', 'RepositoryConnection', 'IssueConnection', 'PullRequestConnection',
  'RefConnection', 'CommentConnection', 'SearchResultItemConnection', 'PageInfo',
  'IssueEdge', 'PullRequestEdge', 'RepositoryEdge', 'String', 'Int', 'Boolean', 'ID',
];

const KIND_OF: Record<string, string> = {
  Query: 'OBJECT', Mutation: 'OBJECT', Repository: 'OBJECT', User: 'OBJECT',
  Issue: 'OBJECT', PullRequest: 'OBJECT', Label: 'OBJECT', Comment: 'OBJECT',
  RepositoryConnection: 'OBJECT', IssueConnection: 'OBJECT', PullRequestConnection: 'OBJECT',
  RefConnection: 'OBJECT', CommentConnection: 'OBJECT', SearchResultItemConnection: 'OBJECT',
  PageInfo: 'OBJECT', IssueEdge: 'OBJECT', PullRequestEdge: 'OBJECT', RepositoryEdge: 'OBJECT',
  String: 'SCALAR', Int: 'SCALAR', Boolean: 'SCALAR', ID: 'SCALAR',
};

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', 'issues', 'pullRequests', '__typename'],
  Mutation: ['createIssue', 'createPullRequest', 'closeIssue', 'reopenIssue', 'addComment'],
  Repository: ['id', 'name', 'fullName', 'description', 'isPrivate', 'private', 'defaultBranchRef', 'createdAt', 'updatedAt', 'pushedAt', 'size', 'databaseId', 'owner', 'issues', 'pullRequests', 'refs', 'branches', '__typename'],
  User: ['id', 'login', 'name', 'email', 'createdAt', '__typename'],
  Issue: ['id', 'number', 'author', 'user', 'title', 'body', 'state', 'labels', 'createdAt', 'updatedAt', 'closedAt', 'comments', '__typename'],
  PullRequest: ['id', 'number', 'author', 'user', 'title', 'body', 'state', 'labels', 'createdAt', 'updatedAt', 'closedAt', 'comments', 'headRefName', 'baseRefName', 'head', 'base', '__typename'],
  Label: ['id', 'name', 'color', 'description', '__typename'],
  Comment: ['id', 'user', 'author', 'createdAt', 'updatedAt', 'body', '__typename'],
  RepositoryConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  RefConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  CommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  SearchResultItemConnection: ['nodes', 'pageInfo', 'totalCount', 'issueCount', 'repositoryCount', 'userCount', '__typename'],
  PageInfo: ['startCursor', 'endCursor', 'hasNextPage', 'hasPrevPage', '__typename'],
  IssueEdge: ['node', 'cursor', '__typename'],
  PullRequestEdge: ['node', 'cursor', '__typename'],
  RepositoryEdge: ['node', 'cursor', '__typename'],
};

const FIELD_TYPE: Record<string, [string, boolean, boolean]> = {};
function ft(name: string, type: string, list = false, nonNull = false): void {
  FIELD_TYPE[name] = [type, list, nonNull];
}
ft('id', 'ID'); ft('number', 'Int'); ft('name', 'String'); ft('login', 'String');
ft('email', 'String'); ft('fullName', 'String'); ft('description', 'String');
ft('isPrivate', 'Boolean'); ft('private', 'Boolean'); ft('createdAt', 'String');
ft('updatedAt', 'String'); ft('pushedAt', 'String'); ft('size', 'Int');
ft('databaseId', 'Int'); ft('color', 'String'); ft('body', 'String');
ft('title', 'String'); ft('state', 'String'); ft('closedAt', 'String');
ft('headRefName', 'String'); ft('baseRefName', 'String'); ft('head', 'String'); ft('base', 'String');
ft('startCursor', 'String'); ft('endCursor', 'String'); ft('hasNextPage', 'Boolean');
ft('hasPrevPage', 'Boolean'); ft('cursor', 'String'); ft('totalCount', 'Int');
ft('issueCount', 'Int'); ft('repositoryCount', 'Int'); ft('userCount', 'Int');
ft('viewer', 'User'); ft('node', 'Query'); ft('repository', 'Repository');
ft('owner', 'User'); ft('author', 'User'); ft('user', 'User'); ft('label', 'Label');
ft('comment', 'Comment'); ft('issue', 'Issue'); ft('pullRequest', 'PullRequest');
ft('defaultBranchRef', 'Query');
ft('issues', 'IssueConnection', true); ft('pullRequests', 'PullRequestConnection', true);
ft('comments', 'CommentConnection', true); ft('refs', 'RefConnection', true);
ft('branches', 'RefConnection', true); ft('labels', 'Label', true);
ft('nodes', 'Query', true); ft('edges', 'IssueEdge', true); ft('pageInfo', 'PageInfo');
ft('search', 'SearchResultItemConnection'); ft('issues', 'IssueConnection', true && true, false);

function typeOfField(name: string, type: string): string {
  const owned = FIELD_TYPE[name];
  if (owned) return owned[0];
  switch (name) {
    case 'nodes': return type.replace('Connection', '');
    case 'edges': return type;
    default: return 'String';
  }
}

function listOf(name: string, type: string): boolean {
  const owned = FIELD_TYPE[name];
  if (owned) return owned[1];
  if (name === 'nodes' || name === 'edges' || name === 'labels') return true;
  return false;
}

function ofType(t: string, list: boolean): any {
  if (list) return { kind: 'LIST', ofType: { kind: KIND_OF[t] || 'OBJECT', name: t, ofType: null } };
  return { kind: KIND_OF[t] || 'OBJECT', name: t, ofType: null };
}

function introspectType(name: string): any | null {
  if (!KIND_OF[name]) return null;
  return {
    kind: KIND_OF[name],
    name,
    description: null,
    fields: TYPE_FIELDS[name]
      ? TYPE_FIELDS[name].map((f) => ({
          name: f,
          description: null,
          args: [],
          type: ofType(typeOfField(f, name), listOf(f, name)),
          isDeprecated: false,
          deprecationReason: null,
        }))
      : null,
    inputFields: null,
    interfaces: [],
    enumValues: null,
    possibleTypes: null,
  };
}

function resolveType(name: string, field: FieldNode): any {
  const t = introspectType(name);
  if (!t) return null;
  return t;
}

function resolveSchema(field: FieldNode, store: Store): any {
  const sub = field.sub || [];
  const out: any = {};
  for (const sf of sub) {
    switch (sf.name) {
      case 'queryType': out.queryType = { name: 'Query' }; break;
      case 'mutationType': out.mutationType = { name: 'Mutation' }; break;
      case 'subscriptionType': out.subscriptionType = null; break;
      case 'types':
        out.types = TYPES.map(introspectType);
        break;
      case 'directives': out.directives = []; break;
      default: out[sf.name] = null;
    }
  }
  return out;
}

// ---------- selection executor ----------

function executeSelection(fields: FieldNode[], parent: any, parentType: string, store: Store): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.alias || field.name;
    if (field.name === '__typename') {
      result[key] = parentType;
      continue;
    }
    if (isIntrospectType(parentType)) {
      if (field.sub === null) {
        result[key] = resolveIntrospectLeaf(field, parent, parentType);
      } else {
        const subParent = resolveIntrospectObj(field, parent, parentType);
        const subType = introspectChildType(field, parentType);
        if (Array.isArray(subParent)) {
          result[key] = subParent.map((it: any) => executeSelection(field.sub!, it, subType, store));
        } else if (subParent != null && typeof subParent === 'object') {
          result[key] = executeSelection(field.sub!, subParent, subType, store);
        } else {
          result[key] = subParent;
        }
      }
      continue;
    }
    // edge objects (IssueEdge etc) - plain {node, cursor}
    if (parentType === 'IssueEdge' || parentType === 'PullRequestEdge' || parentType === 'RepositoryEdge' || parentType === 'Node') {
      if (field.sub === null) {
        result[key] = resolveEdgeLeaf(field, parent, parentType);
      } else {
        const subParent = resolveEdgeObj(field, parent, parentType);
        const subType = subParent && subParent.__gqlType ? subParent.__gqlType : edgeChildType(field, parentType);
        if (Array.isArray(subParent)) {
          result[key] = subParent.map((it: any) => executeSelection(field.sub!, it, (it && it.__gqlType) || subType, store));
        } else if (subParent != null && typeof subParent === 'object') {
          result[key] = executeSelection(field.sub!, subParent, subType, store);
        } else {
          result[key] = subParent;
        }
      }
      continue;
    }
    if (field.sub === null) {
      const val = resolveField(field, { store, parent, parentType });
      result[key] = val;
      continue;
    }
    const subParent = resolveField(field, { store, parent, parentType });
    const subType = subParent && subParent.__gqlType ? subParent.__gqlType : childType(field, parentType);
    if (Array.isArray(subParent)) {
      result[key] = subParent.map((it: any) => executeSelection(field.sub!, it, (it && it.__gqlType) || subType, store));
    } else if (subParent != null && typeof subParent === 'object') {
      result[key] = executeSelection(field.sub!, subParent, subType, store);
    } else {
      result[key] = subParent;
    }
  }
  return result;
}

function resolveEdgeLeaf(field: FieldNode, parent: any, parentType: string): any {
  const name = field.name;
  if (name === '__typename') return parentType;
  if (name === 'cursor') return parent.cursor;
  if (name === 'node') return parent.node;
  return null;
}

function resolveEdgeObj(field: FieldNode, parent: any, parentType: string): any {
  const name = field.name;
  if (name === '__typename') return parentType;
  if (name === 'cursor') return parent.cursor;
  if (name === 'node') return parent.node;
  return null;
}

function edgeChildType(field: FieldNode, parentType: string): string {
  if (field.name === 'node') return 'Query';
  return parentType;
}

function introspectChildType(field: FieldNode, parentType: string): string {
  const name = field.name;
  if (name === 'ofType' || name === 'type') return '__Type';
  if (name === 'fields') return '__Field';
  if (name === 'args' || name === 'inputFields') return '__InputValue';
  if (name === 'enumValues') return '__EnumValue';
  if (name === 'interfaces' || name === 'possibleTypes') return '__Type';
  if (name === 'types' || name === 'directives') return '__Type';
  if (name === 'queryType' || name === 'mutationType' || name === 'subscriptionType') return '__Type';
  if (name === 'type' && parentType === '__Field') return '__Type';
  return parentType;
}

function childType(field: FieldNode, parentType: string): string {
  const name = field.name;
  switch (name) {
    case 'viewer': return 'User';
    case 'repository': return 'Repository';
    case 'owner': return 'User';
    case 'author': case 'user': return 'User';
    case 'node': return 'Node';
    case 'search': return 'SearchResultItemConnection';
    case 'issues': return 'IssueConnection';
    case 'pullRequests': return 'PullRequestConnection';
    case 'comments': return 'CommentConnection';
    case 'refs': case 'branches': return 'RefConnection';
    case 'labels': return 'Label';
    case 'nodes': return 'Query';
    case 'edges': return 'IssueEdge';
    case 'pageInfo': return 'PageInfo';
    case 'defaultBranchRef': return 'Query';
    case 'issue': return 'Issue';
    case 'pullRequest': return 'PullRequest';
    case 'comment': return 'Comment';
    case '__schema': return '__Schema';
    case '__type': return '__Type';
    default:
      if (parentType === 'Issue' || parentType === 'PullRequest') return parentType;
      return parentType;
  }
}

function introspectLeaf(parent: any, name: string): any {
  if (name === '__typename') return parent && parent.__typename;
  if (parent == null) return null;
  if (name === 'kind') return parent.kind;
  if (name === 'name') return parent.name;
  if (name === 'description') return parent.description || null;
  if (name === 'fields') return parent.fields || [];
  if (name === 'inputFields') return parent.inputFields;
  if (name === 'interfaces') return parent.interfaces || [];
  if (name === 'enumValues') return parent.enumValues;
  if (name === 'possibleTypes') return parent.possibleTypes;
  if (name === 'ofType') return parent.ofType;
  if (name === 'args') return parent.args || [];
  if (name === 'isDeprecated') return parent.isDeprecated || false;
  if (name === 'deprecationReason') return parent.deprecationReason || null;
  if (name === 'type') return parent.type;
  if (name === 'defaultValue') return parent.defaultValue ?? null;
  return parent[name] ?? null;
}

function introspectObj(parent: any, name: string): any {
  if (name === '__typename') return parent.__typename;
  if (parent == null) return null;
  if (name === 'fields' || name === 'interfaces' || name === 'enumValues' || name === 'possibleTypes' || name === 'inputFields' || name === 'types' || name === 'directives') {
    return parent[name] || [];
  }
  if (name === 'ofType' || name === 'type') return parent[name] || null;
  if (name === 'queryType' || name === 'mutationType' || name === 'subscriptionType') return parent[name] || null;
  return parent[name] ?? null;
}

function isIntrospectType(t: string): boolean {
  return t === '__Schema' || t === '__Type' || t === '__Field' || t === '__InputValue' || t === '__EnumValue' || t === '__Directive' || t === 'Node';
}

function resolveIntrospectObj(field: FieldNode, parent: any, parentType: string): any {
  const name = field.name;
  if (name === '__typename') return parentType;
  // __Type's 'fields'/'interfaces' etc return arrays of introspect objects
  if (name === 'fields' || name === 'inputFields' || name === 'interfaces' || name === 'enumValues' || name === 'possibleTypes' || name === 'types' || name === 'directives') {
    return parent[name] || [];
  }
  if (name === 'ofType' || name === 'type') return parent[name] || null;
  if (name === 'queryType' || name === 'mutationType' || name === 'subscriptionType') return parent[name] || null;
  if (name === 'args') return parent[name] || [];
  if (name === 'type' && parentType === '__Field') return parent.type || null;
  return introspectLeaf(parent, name);
}

function resolveIntrospectLeaf(field: FieldNode, parent: any, parentType: string): any {
  const name = field.name;
  if (name === '__typename') return parentType;
  if (parent == null) return null;
  return introspectLeaf(parent, name);
}

// ---------- entrypoint ----------

function stripTypes(value: any): any {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(stripTypes);
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value)) {
      if (k === '__gqlType') continue;
      out[k] = stripTypes(value[k]);
    }
    return out;
  }
  return value;
}

function collectVariables(body: any): Map<string, unknown> {
  const vars = new Map<string, unknown>();
  const src = body.variables;
  if (src && typeof src === 'object') {
    for (const k of Object.keys(src)) vars.set(k, src[k]);
  }
  return vars;
}

export async function handleGraphQL(args: GraphQLArgs, req: any, res: any): Promise<void> {
  const store = args.store;
  let query: string = '';
  let variables: Map<string, unknown> = new Map();
  let operationName: string | null = null;
  try {
    if ((args.method || 'GET').toUpperCase() === 'GET') {
      const raw = typeof req === 'string' ? req : (req && (req.url || req.rawUrl || ''));
      const qs = raw.split('?');
      const params = new URLSearchParams(qs.length > 1 ? qs[1] : '');
      query = params.get('query') || '';
      const v = params.get('variables');
      if (v) {
        try {
          const parsed = JSON.parse(v);
          variables = collectVariables({ variables: parsed });
        } catch { /* ignore */ }
      }
      operationName = params.get('operationName');
    } else {
      let parsed: any = null;
      try {
        parsed = JSON.parse(args.body || '');
      } catch (e: any) {
        writeReply(res, 200, { errors: [{ message: 'JSON parse error: ' + (e && e.message || 'bad JSON') }] });
        return;
      }
      query = (parsed && parsed.query) || '';
      variables = collectVariables(parsed);
      operationName = parsed && parsed.operationName || null;
    }
    if (!query || !query.trim()) {
      writeReply(res, 200, { errors: [{ message: 'Must provide query string.' }] });
      return;
    }
    const op = parseDocument(query, variables);
    let data: Record<string, unknown> = {};
    if (op.op === 'mutation') {
      data = executeSelection(op.fields, {}, 'Mutation', store);
    } else {
      data = executeSelection(op.fields, {}, 'Query', store);
    }
    writeReply(res, 200, { data: stripTypes(data) });
  } catch (e: any) {
    const message = (e && e.message) || String(e);
    writeReply(res, 200, { errors: [{ message }] });
  }
}

export const handleGraphql = handleGraphQL;

function writeReply(res: any, status: number, payload: any): void {
  const body = JSON.stringify(payload);
  if (res && typeof res.writeHead === 'function') {
    res.writeHead(status, { 'Content-Type': 'application/json' });
  } else if (res && typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/json');
  } else if (res && typeof res.status === 'function') {
    res.status(status);
  }
  if (res && typeof res.end === 'function') {
    res.end(body);
  } else if (res && typeof res.send === 'function') {
    res.send(body);
  }
}
