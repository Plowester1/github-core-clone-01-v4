import type { ServerResponse } from 'node:http';
import { commitView, diffTrees, putCommit, sendJson } from './rest.ts';
import { bumpRepoCache, type Store, type Repo, type Issue, type Comment, type User, type Pull } from './store.ts';

export const GRAPHQL_PATH = '/graphql';

export interface GraphQLArgs {
  method: string;
  body: string;
  token: string;
}

interface Token { kind: 'name' | 'string' | 'number' | 'punct'; value: string }
interface VariableRef { __variable: string }
type GqlValue = string | number | boolean | null | GqlValue[] | { [key: string]: GqlValue } | VariableRef;
type Resolved = string | number | boolean | null | Resolved[] | { [key: string]: Resolved };
interface FieldNode { name: string; alias: string; args: Map<string, GqlValue>; selections: FieldNode[] }
interface Document { kind: 'query' | 'mutation'; fields: FieldNode[] }
type FieldHandlers<T> = Record<string, (value: T, field: FieldNode) => unknown>;

class GqlError extends Error {}

const TOKEN_RE = /\.\.\.|"(?:\\.|[^"\\])*"|[_A-Za-z][_0-9A-Za-z]*|-?\d+(?:\.\d+)?|[{}():\[\],$!=@|&]|\S/g;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(source)) !== null) {
    const text = match[0];
    if (text.startsWith('"')) tokens.push({ kind: 'string', value: JSON.parse(text) });
    else if (/^[_A-Za-z]/.test(text)) tokens.push({ kind: 'name', value: text });
    else if (/^-?\d/.test(text)) tokens.push({ kind: 'number', value: text });
    else tokens.push({ kind: 'punct', value: text });
  }
  return tokens;
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined { return this.tokens[this.index]; }
  private take(): Token {
    const token = this.peek();
    if (token === undefined) throw new GqlError('Bad Request');
    this.index += 1;
    return token;
  }
  private expect(value: string): void {
    if (this.take().value !== value) throw new GqlError('Bad Request');
  }
  private name(): string {
    const token = this.take();
    if (token.kind !== 'name') throw new GqlError('Bad Request');
    return token.value;
  }

  parse(): Document {
    let kind: 'query' | 'mutation' = 'query';
    if (this.peek()?.kind === 'name' && (this.peek()!.value === 'query' || this.peek()!.value === 'mutation')) {
      kind = this.take().value as 'query' | 'mutation';
      if (this.peek()?.kind === 'name') this.take();
      if (this.peek()?.value === '(') this.variableDefinitions();
    }
    const fields = this.selectionSet();
    if (this.peek() !== undefined) throw new GqlError('Bad Request');
    return { kind, fields };
  }

  private variableDefinitions(): void {
    this.expect('(');
    while (this.peek()?.value !== ')') {
      this.expect('$');
      this.name();
      this.expect(':');
      if (this.peek()?.value === '[') {
        this.take();
        while (this.peek() !== undefined && this.take().value !== ']') {}
      } else {
        this.name();
        if (this.peek()?.value === '!') this.take();
      }
      if (this.peek()?.value === '=') {
        this.take();
        this.value();
      }
      if (this.peek()?.value === ',') this.take();
    }
    this.expect(')');
  }

  private selectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek()?.value !== '}') {
      if (this.peek() === undefined) throw new GqlError('Bad Request');
      if (this.peek()!.value === '...') {
        this.take();
        if (this.peek()?.value === 'on') {
          this.take();
          this.name();
        }
        fields.push(...this.selectionSet());
        continue;
      }
      let name = this.name();
      let alias = name;
      if (this.peek()?.value === ':') {
        this.take();
        alias = name;
        name = this.name();
      }
      const args = new Map<string, GqlValue>();
      if (this.peek()?.value === '(') {
        this.take();
        while (this.peek()?.value !== ')') {
          const key = this.name();
          this.expect(':');
          args.set(key, this.value());
          if (this.peek()?.value === ',') this.take();
        }
        this.expect(')');
      }
      const selections = this.peek()?.value === '{' ? this.selectionSet() : [];
      fields.push({ name, alias, args, selections });
    }
    this.expect('}');
    return fields;
  }

  private value(): GqlValue {
    const token = this.take();
    if (token.value === '$') return { __variable: this.name() };
    if (token.value === '{') {
      const object: { [key: string]: GqlValue } = {};
      while (this.peek()?.value !== '}') {
        const key = this.name();
        this.expect(':');
        object[key] = this.value();
        if (this.peek()?.value === ',') this.take();
      }
      this.expect('}');
      return object;
    }
    if (token.value === '[') {
      const values: GqlValue[] = [];
      while (this.peek()?.value !== ']') {
        values.push(this.value());
        if (this.peek()?.value === ',') this.take();
      }
      this.expect(']');
      return values;
    }
    if (token.kind === 'number') return Number(token.value);
    if (token.kind === 'string') return token.value;
    if (token.value === 'true') return true;
    if (token.value === 'false') return false;
    if (token.value === 'null') return null;
    return token.value;
  }
}

function isVariable(value: GqlValue): value is VariableRef {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && '__variable' in value;
}

function resolveValue(value: GqlValue | undefined, variables: Record<string, Resolved>): Resolved {
  if (value === undefined) return null;
  if (isVariable(value)) {
    if (!Object.prototype.hasOwnProperty.call(variables, value.__variable)) {
      throw new GqlError(`Variable "$${value.__variable}" is not defined.`);
    }
    return variables[value.__variable];
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, variables));
  if (typeof value === 'object' && value !== null) {
    const result: { [key: string]: Resolved } = {};
    for (const [key, item] of Object.entries(value)) result[key] = resolveValue(item, variables);
    return result;
  }
  return value;
}

function unknownField(name: string, type: string): never {
  throw new GqlError(`Field '${name}' doesn't exist on type '${type}'.`);
}

function selectFields<T>(value: T, selections: FieldNode[], handlers: FieldHandlers<T>, type: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of selections) {
    const handler = handlers[field.name];
    if (handler === undefined) unknownField(field.name, type);
    result[field.alias] = handler(value, field);
  }
  return result;
}

const viewerHandlers: FieldHandlers<User> = {
  login: (user) => user.login,
  id: (user) => String(user.id),
  name: (user) => user.name,
  email: (user) => user.email,
};

function repositoryGlobalId(repo: Repo): string {
  return `R_${repo.id}`;
}
function issueGlobalId(issue: Issue): string {
  return `I_${issue.id}`;
}
function commentGlobalId(comment: Comment): string {
  return `C_${comment.id}`;
}
function pullGlobalId(pull: Pull): string {
  return `PR_${pull.id}`;
}

const issueHandlers: FieldHandlers<Issue> = {
  id: (issue) => issueGlobalId(issue),
  number: (issue) => issue.number,
  title: (issue) => issue.title,
  body: (issue) => issue.body,
  state: (issue) => issue.state.toUpperCase(),
  createdAt: (issue) => issue.createdAt,
  updatedAt: (issue) => issue.updatedAt,
  author: (issue, field) => selectFields(issue.user, field.selections, viewerHandlers, 'User'),
};

const commentHandlers: FieldHandlers<Comment> = {
  id: (comment) => commentGlobalId(comment),
  body: (comment) => comment.body,
  createdAt: (comment) => comment.createdAt,
  updatedAt: (comment) => comment.updatedAt,
  author: (comment, field) => selectFields(comment.user, field.selections, viewerHandlers, 'User'),
};

interface PullValue {
  pull: Pull;
  repo: Repo;
}
interface FileValue {
  path: string;
  additions: number;
  deletions: number;
  changes: number;
}

const fileHandlers: FieldHandlers<FileValue> = {
  path: (file) => file.path,
  filename: (file) => file.path,
  additions: (file) => file.additions,
  deletions: (file) => file.deletions,
  changes: (file) => file.changes,
};

const pullHandlers: FieldHandlers<PullValue> = {
  id: (value) => pullGlobalId(value.pull),
  number: (value) => value.pull.number,
  title: (value) => value.pull.title,
  body: (value) => value.pull.body,
  state: (value) => value.pull.state.toUpperCase(),
  merged: (value) => value.pull.merged,
  mergeable: (value) => value.pull.mergeable ? 'MERGEABLE' : 'CONFLICTING',
  headRefName: (value) => value.pull.head,
  baseRefName: (value) => value.pull.base,
  files: (value, field) => projectPullFiles(value.repo, value.pull, field),
};

function argumentNumber(field: FieldNode, name: string, variables: Record<string, Resolved>): number {
  const value = resolveValue(field.args.get(name), variables);
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number)) throw new GqlError(`Argument '${name}' must be an integer.`);
  return number;
}
function argumentString(field: FieldNode, name: string, variables: Record<string, Resolved>): string | null {
  const value = resolveValue(field.args.get(name), variables);
  return typeof value === 'string' ? value : null;
}

function issueCursor(issue: Issue): string {
  return `issue:${issue.number}`;
}
function cursorIssueNumber(cursor: string | null): number | null {
  if (cursor === null || !cursor.startsWith('issue:')) return null;
  const number = Number(cursor.slice('issue:'.length));
  return Number.isInteger(number) ? number : null;
}

function projectPageInfo(items: Issue[], hasNextPage: boolean): Record<string, unknown> {
  const last = items[items.length - 1];
  return {
    hasNextPage,
    hasPreviousPage: false,
    startCursor: items[0] === undefined ? null : issueCursor(items[0]),
    endCursor: last === undefined ? null : issueCursor(last),
  };
}

function projectIssueNodes(issues: Issue[], field: FieldNode): unknown[] {
  return issues.map((issue) => selectFields(issue, field.selections, issueHandlers, 'Issue'));
}

function projectIssues(issues: Issue[], field: FieldNode, variables: Record<string, Resolved>): Record<string, unknown> {
  const first = field.args.has('first') ? Math.max(0, argumentNumber(field, 'first', variables)) : 30;
  const after = argumentString(field, 'after', variables);
  const statesValue = resolveValue(field.args.get('states'), variables);
  const orderByValue = resolveValue(field.args.get('orderBy'), variables);
  let selected = [...issues];
  if (Array.isArray(statesValue)) {
    const states = new Set(statesValue.map((state) => String(state).toUpperCase()));
    selected = selected.filter((issue) => states.has(issue.state.toUpperCase()));
  }
  if (orderByValue !== null && typeof orderByValue === 'object' && !Array.isArray(orderByValue)) {
    const direction = orderByValue.direction;
    if (direction === 'DESC') selected.reverse();
  }
  const afterNumber = cursorIssueNumber(after);
  if (afterNumber !== null) {
    const index = selected.findIndex((issue) => issue.number === afterNumber);
    selected = index < 0 ? selected : selected.slice(index + 1);
  }
  const page = selected.slice(0, first);
  const hasNextPage = selected.length > page.length;
  return selectFields({ issues: page }, field.selections, {
    nodes: (value, nodeField) => projectIssueNodes(value.issues, nodeField),
    edges: (value, edgeField) => value.issues.map((issue) => selectFields({ issue }, edgeField.selections, {
      node: (edge, nodeField) => selectFields(edge.issue, nodeField.selections, issueHandlers, 'Issue'),
    }, 'IssueEdge')),
    pageInfo: (value, pageField) => selectFields(projectPageInfo(value.issues, hasNextPage), pageField.selections, {
      hasNextPage: (pageInfo) => pageInfo.hasNextPage,
      hasPreviousPage: (pageInfo) => pageInfo.hasPreviousPage,
      startCursor: (pageInfo) => pageInfo.startCursor,
      endCursor: (pageInfo) => pageInfo.endCursor,
    }, 'PageInfo'),
    totalCount: (value) => value.issues.length,
  }, 'IssueConnection');
}

function pullTip(repo: Repo, branch: string, fallback: string): string {
  return repo.refs.get(`refs/heads/${branch}`) ?? fallback;
}

function projectPullFiles(repo: Repo, pull: Pull, field: FieldNode): Record<string, unknown> {
  const baseOid = pull.baseSha;
  const headOid = pullTip(repo, pull.head, pull.headSha);
  const files: FileValue[] = diffTrees(repo, baseOid, headOid).map((diff) => ({
    path: diff.filename,
    additions: diff.additions,
    deletions: diff.deletions,
    changes: diff.changes,
  }));
  return selectFields({ files }, field.selections, {
    nodes: (value, nodeField) => value.files.map((file) => selectFields(file, nodeField.selections, fileHandlers, 'PullRequestChangedFile')),
    edges: (value, edgeField) => value.files.map((file) => selectFields({ file }, edgeField.selections, {
      node: (edge, nodeField) => selectFields(edge.file, nodeField.selections, fileHandlers, 'PullRequestChangedFile'),
    }, 'PullRequestChangedFileEdge')),
    pageInfo: (value, pageField) => selectFields({
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    }, pageField.selections, {
      hasNextPage: (pageInfo) => pageInfo.hasNextPage,
      hasPreviousPage: (pageInfo) => pageInfo.hasPreviousPage,
      startCursor: (pageInfo) => pageInfo.startCursor,
      endCursor: (pageInfo) => pageInfo.endCursor,
    }, 'PageInfo'),
  }, 'PullRequestChangedFileConnection');
}

function projectPulls(repo: Repo, pulls: Pull[], field: FieldNode, variables: Record<string, Resolved>): Record<string, unknown> {
  const first = field.args.has('first') ? Math.max(0, argumentNumber(field, 'first', variables)) : 30;
  const page = pulls.slice(0, first);
  return selectFields({ pulls: page }, field.selections, {
    nodes: (value, nodeField) => value.pulls.map((pull) => selectFields({ pull, repo }, nodeField.selections, pullHandlers, 'PullRequest')),
    edges: (value, edgeField) => value.pulls.map((pull) => selectFields({ pull, repo }, edgeField.selections, {
      node: (edge, nodeField) => selectFields(edge, nodeField.selections, pullHandlers, 'PullRequest'),
    }, 'PullRequestEdge')),
    pageInfo: (value, pageField) => selectFields({
      hasNextPage: pulls.length > page.length,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    }, pageField.selections, {
      hasNextPage: (pageInfo) => pageInfo.hasNextPage,
      hasPreviousPage: (pageInfo) => pageInfo.hasPreviousPage,
      startCursor: (pageInfo) => pageInfo.startCursor,
      endCursor: (pageInfo) => pageInfo.endCursor,
    }, 'PageInfo'),
  }, 'PullRequestConnection');
}

function projectRepository(repo: Repo, selections: FieldNode[], variables: Record<string, Resolved>): Record<string, unknown> {
  return selectFields(repo, selections, {
    id: (value) => repositoryGlobalId(value),
    databaseId: (value) => value.id,
    name: (value) => value.name,
    fullName: (value) => value.fullName,
    nameWithOwner: (value) => value.fullName,
    description: (value) => value.description,
    owner: (value, field) => selectFields(value.owner, field.selections, viewerHandlers, 'User'),
    defaultBranchRef: (value, field) => selectFields({ name: value.defaultBranch }, field.selections, {
      name: (branch) => branch.name,
    }, 'Branch'),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issues: (value, field) => projectIssues(value.issues, field, variables),
    issue: (value, field) => {
      const number = argumentNumber(field, 'number', variables);
      const issue = value.issueByNumber.get(number);
      if (issue === undefined) throw new GqlError(`Could not resolve to an Issue with the number '${number}'.`);
      return selectFields(issue, field.selections, issueHandlers, 'Issue');
    },
    pullRequests: (value, field) => projectPulls(value, value.pulls.filter((pull) => pull.state === 'open'), field, variables),
    pullRequest: (value, field) => {
      const number = argumentNumber(field, 'number', variables);
      const pull = value.pullByNumber.get(number);
      if (pull === undefined) throw new GqlError(`Could not resolve to a PullRequest with the number '${number}'.`);
      return selectFields({ pull, repo: value }, field.selections, pullHandlers, 'PullRequest');
    },
  }, 'Repository');
}

interface SchemaField {
  name: string;
  kind: string;
  type: { name: string; kind: string };
}
interface SchemaType {
  kind: string;
  fields: SchemaField[];
  enumValues?: string[];
}

function schemaField(name: string, typeName: string, kind = 'SCALAR'): SchemaField {
  return { name, kind, type: { name: typeName, kind } };
}

const SCHEMA_TYPES: Record<string, SchemaType> = {
  Issue: {
    kind: 'OBJECT',
    fields: [
      schemaField('id', 'ID'),
      schemaField('number', 'Int'),
      schemaField('title', 'String'),
      schemaField('body', 'String'),
      schemaField('state', 'String'),
      schemaField('createdAt', 'DateTime'),
      schemaField('updatedAt', 'DateTime'),
      schemaField('author', 'User', 'OBJECT'),
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      schemaField('id', 'ID'),
      schemaField('number', 'Int'),
      schemaField('title', 'String'),
      schemaField('body', 'String'),
      schemaField('state', 'String'),
      schemaField('merged', 'Boolean'),
      schemaField('mergeable', 'String'),
      schemaField('headRefName', 'String'),
      schemaField('baseRefName', 'String'),
      schemaField('files', 'PullRequestChangedFileConnection', 'OBJECT'),
    ],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      schemaField('id', 'ID'),
      schemaField('databaseId', 'Int'),
      schemaField('name', 'String'),
      schemaField('nameWithOwner', 'String'),
      schemaField('owner', 'User', 'OBJECT'),
      schemaField('defaultBranchRef', 'Branch', 'OBJECT'),
      schemaField('viewerPermission', 'String'),
      schemaField('hasIssuesEnabled', 'Boolean'),
      schemaField('issue', 'Issue', 'OBJECT'),
      schemaField('issues', 'IssueConnection', 'OBJECT'),
      schemaField('pullRequest', 'PullRequest', 'OBJECT'),
      schemaField('pullRequests', 'PullRequestConnection', 'OBJECT'),
    ],
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER'],
  },
};

function projectIntrospectionType(typeName: string, selections: FieldNode[]): Record<string, unknown> {
  const definition = SCHEMA_TYPES[typeName];
  const typeValue = definition ?? { name: typeName, kind: 'OBJECT', fields: [], enumValues: [] };
  return selectFields(typeValue, selections, {
    name: () => typeName,
    kind: (value) => value.kind,
    fields: (value, field) => (value.fields ?? []).map((schemaFieldValue) => selectFields(schemaFieldValue, field.selections, {
      name: (schemaFieldValue) => schemaFieldValue.name,
      kind: (schemaFieldValue) => schemaFieldValue.kind,
      type: (schemaFieldValue, typeField) => selectFields(schemaFieldValue.type, typeField.selections, {
        name: (type) => type.name,
        kind: (type) => type.kind,
      }, '__Type'),
    }, '__Field')),
    enumValues: (value, field) => (value.enumValues ?? []).map((name) => selectFields({ name }, field.selections, {
      name: (enumValue) => enumValue.name,
    }, '__EnumValue')),
  }, '__Type');
}

function findRepository(store: Store, id: string): Repo | null {
  for (const repo of store.repos.values()) {
    if (repositoryGlobalId(repo) === id || String(repo.id) === id || repo.fullName === id) return repo;
  }
  return null;
}

function findIssue(store: Store, id: string): Issue | null {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues) {
      if (issueGlobalId(issue) === id || String(issue.id) === id || `${repo.fullName}#${issue.number}` === id) return issue;
    }
  }
  return null;
}

function findPull(store: Store, id: string): PullValue | null {
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls) {
      if (pullGlobalId(pull) === id || String(pull.id) === id) return { pull, repo };
    }
  }
  return null;
}

function inputObject(field: FieldNode, variables: Record<string, Resolved>): Record<string, Resolved> {
  const value = resolveValue(field.args.get('input'), variables);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new GqlError("Field 'input' is required.");
  return value as Record<string, Resolved>;
}

function inputString(input: Record<string, Resolved>, name: string, optional = false): string {
  const value = input[name];
  if ((value === undefined || value === null) && optional) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new GqlError(`Field '${name}' is required.`);
  return String(value);
}

function createIssue(store: Store, field: FieldNode, variables: Record<string, Resolved>): Record<string, unknown> {
  const input = inputObject(field, variables);
  const repo = findRepository(store, inputString(input, 'repositoryId'));
  if (repo === null) throw new GqlError(`Could not resolve to a Repository with id '${inputString(input, 'repositoryId')}'.`);
  const title = inputString(input, 'title');
  const body = inputString(input, 'body', true);
  const number = repo.issues.length + 1;
  const issue: Issue = { id: store.nextIssueId, number, title, body, user: store.viewer, state: 'open', labels: [], createdAt: store.nowIso, updatedAt: store.nowIso, comments: [] };
  store.nextIssueId += 1;
  repo.issues.push(issue);
  repo.issueByNumber.set(number, issue);
  return selectFields({ issue }, field.selections, {
    issue: (value, issueField) => selectFields(value.issue, issueField.selections, issueHandlers, 'Issue'),
  }, 'CreateIssuePayload');
}

function closeIssue(store: Store, field: FieldNode, variables: Record<string, Resolved>): Record<string, unknown> {
  const input = inputObject(field, variables);
  const issue = findIssue(store, inputString(input, 'issueId'));
  if (issue === null) throw new GqlError(`Could not resolve to an Issue with id '${inputString(input, 'issueId')}'.`);
  issue.state = 'closed';
  issue.updatedAt = store.nowIso;
  return selectFields({ issue }, field.selections, {
    issue: (value, issueField) => selectFields(value.issue, issueField.selections, issueHandlers, 'Issue'),
  }, 'CloseIssuePayload');
}

function reopenIssue(store: Store, field: FieldNode, variables: Record<string, Resolved>): Record<string, unknown> {
  const input = inputObject(field, variables);
  const issue = findIssue(store, inputString(input, 'issueId'));
  if (issue === null) throw new GqlError(`Could not resolve to an Issue with id '${inputString(input, 'issueId')}'.`);
  issue.state = 'open';
  issue.updatedAt = store.nowIso;
  return selectFields({ issue }, field.selections, {
    issue: (value, issueField) => selectFields(value.issue, issueField.selections, issueHandlers, 'Issue'),
  }, 'ReopenIssuePayload');
}

function createPullRequest(store: Store, field: FieldNode, variables: Record<string, Resolved>): Record<string, unknown> {
  const input = inputObject(field, variables);
  const repo = findRepository(store, inputString(input, 'repositoryId'));
  if (repo === null) throw new GqlError(`Could not resolve to a Repository with id '${inputString(input, 'repositoryId')}'.`);
  const head = inputString(input, 'headRefName');
  const base = inputString(input, 'baseRefName');
  const headOid = repo.refs.get(`refs/heads/${head}`);
  const baseOid = repo.refs.get(`refs/heads/${base}`);
  if (headOid === undefined || baseOid === undefined) throw new GqlError(`Could not resolve to a branch for the pull request.`);
  const number = repo.pulls.length + 1;
  const pull: Pull = {
    id: store.nextPullId,
    number,
    title: inputString(input, 'title'),
    body: inputString(input, 'body', true),
    user: store.viewer,
    state: 'open',
    head,
    base,
    headSha: headOid,
    baseSha: baseOid,
    mergeCommitSha: null,
    merged: false,
    mergeable: true,
    createdAt: store.nowIso,
    updatedAt: store.nowIso,
    mergedAt: null,
  };
  store.nextPullId += 1;
  repo.pulls.push(pull);
  repo.pullByNumber.set(number, pull);
  return selectFields({ pull: { pull, repo } }, field.selections, {
    pullRequest: (value, pullField) => selectFields(value.pull, pullField.selections, pullHandlers, 'PullRequest'),
  }, 'CreatePullRequestPayload');
}

function mergePullRequest(store: Store, field: FieldNode, variables: Record<string, Resolved>): Record<string, unknown> {
  const input = inputObject(field, variables);
  const value = findPull(store, inputString(input, 'pullRequestId'));
  if (value === null) throw new GqlError(`Could not resolve to a PullRequest with id '${inputString(input, 'pullRequestId')}'.`);
  const { pull, repo } = value;
  if (pull.state !== 'open') throw new GqlError('Pull Request is not mergeable');
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const headView = headTip === undefined ? null : commitView(repo, headTip);
  if (baseTip === undefined || headTip === undefined || headView === null) throw new GqlError('Pull Request is not mergeable');
  const mergeCommit = putCommit(repo, headView.tree, [baseTip, headTip], `Merge pull request #${pull.number}\n`);
  repo.refs.set(`refs/heads/${pull.base}`, mergeCommit);
  bumpRepoCache(repo);
  if (pull.base === repo.defaultBranch) repo.headOid = mergeCommit;
  pull.state = 'merged';
  pull.merged = true;
  pull.mergeable = true;
  pull.mergeCommitSha = mergeCommit;
  pull.mergedAt = store.nowIso;
  pull.updatedAt = store.nowIso;
  return selectFields({ pull: value }, field.selections, {
    pullRequest: (payload, pullField) => selectFields(payload.pull, pullField.selections, pullHandlers, 'PullRequest'),
  }, 'MergePullRequestPayload');
}

function closePullRequest(store: Store, field: FieldNode, variables: Record<string, Resolved>): Record<string, unknown> {
  const input = inputObject(field, variables);
  const value = findPull(store, inputString(input, 'pullRequestId'));
  if (value === null) throw new GqlError(`Could not resolve to a PullRequest with id '${inputString(input, 'pullRequestId')}'.`);
  value.pull.state = 'closed';
  value.pull.updatedAt = store.nowIso;
  return selectFields({ pull: value }, field.selections, {
    pullRequest: (payload, pullField) => selectFields(payload.pull, pullField.selections, pullHandlers, 'PullRequest'),
  }, 'ClosePullRequestPayload');
}

function reopenPullRequest(store: Store, field: FieldNode, variables: Record<string, Resolved>): Record<string, unknown> {
  const input = inputObject(field, variables);
  const value = findPull(store, inputString(input, 'pullRequestId'));
  if (value === null) throw new GqlError(`Could not resolve to a PullRequest with id '${inputString(input, 'pullRequestId')}'.`);
  value.pull.state = 'open';
  value.pull.updatedAt = store.nowIso;
  return selectFields({ pull: value }, field.selections, {
    pullRequest: (payload, pullField) => selectFields(payload.pull, pullField.selections, pullHandlers, 'PullRequest'),
  }, 'ReopenPullRequestPayload');
}

function addComment(store: Store, field: FieldNode, variables: Record<string, Resolved>): Record<string, unknown> {
  const input = inputObject(field, variables);
  const issue = findIssue(store, inputString(input, 'subjectId'));
  if (issue === null) throw new GqlError(`Could not resolve to a subject with id '${inputString(input, 'subjectId')}'.`);
  const comment: Comment = { id: store.nextCommentId, user: store.viewer, body: inputString(input, 'body'), createdAt: store.nowIso, updatedAt: store.nowIso };
  store.nextCommentId += 1;
  issue.comments.push(comment);
  issue.updatedAt = store.nowIso;
  return selectFields({ comment }, field.selections, {
    commentEdge: (value, edgeField) => selectFields(value, edgeField.selections, {
      node: (edge, nodeField) => selectFields(edge.comment, nodeField.selections, commentHandlers, 'IssueComment'),
    }, 'IssueCommentEdge'),
  }, 'AddCommentPayload');
}

function execute(store: Store, document: Document, variables: Record<string, Resolved>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of document.fields) {
    if (field.name === 'viewer' && document.kind === 'query') {
      data[field.alias] = selectFields(store.viewer, field.selections, viewerHandlers, 'User');
    } else if (field.name === 'repository' && document.kind === 'query') {
      const owner = resolveValue(field.args.get('owner'), variables);
      const name = resolveValue(field.args.get('name'), variables);
      let repo: Repo | undefined;
      if (typeof owner === 'string' && typeof name === 'string') repo = store.repos.get(`${owner}/${name}`);
      else if (store.repos.size === 1) repo = [...store.repos.values()][0];
      data[field.alias] = repo === undefined ? null : projectRepository(repo, field.selections, variables);
    } else if (field.name === '__type' && document.kind === 'query') {
      const name = resolveValue(field.args.get('name'), variables);
      data[field.alias] = typeof name === 'string' ? projectIntrospectionType(name, field.selections) : null;
    } else if (field.name === '__schema' && document.kind === 'query') {
      data[field.alias] = selectFields({}, field.selections, {
        queryType: (value, subField) => selectFields({ name: 'Query' }, subField.selections, { name: (t) => t.name }, '__Type'),
        mutationType: (value, subField) => selectFields({ name: 'Mutation' }, subField.selections, { name: (t) => t.name }, '__Type'),
      }, '__Schema');
    } else if (field.name === 'node' && document.kind === 'query') {
      const id = resolveValue(field.args.get('id'), variables);
      const repo = typeof id === 'string' ? findRepository(store, id) : null;
      data[field.alias] = repo === null ? null : projectRepository(repo, field.selections, variables);
    } else if (field.name === 'createIssue' && document.kind === 'mutation') {
      data[field.alias] = createIssue(store, field, variables);
    } else if (field.name === 'closeIssue' && document.kind === 'mutation') {
      data[field.alias] = closeIssue(store, field, variables);
    } else if (field.name === 'reopenIssue' && document.kind === 'mutation') {
      data[field.alias] = reopenIssue(store, field, variables);
    } else if (field.name === 'createPullRequest' && document.kind === 'mutation') {
      data[field.alias] = createPullRequest(store, field, variables);
    } else if (field.name === 'mergePullRequest' && document.kind === 'mutation') {
      data[field.alias] = mergePullRequest(store, field, variables);
    } else if (field.name === 'closePullRequest' && document.kind === 'mutation') {
      data[field.alias] = closePullRequest(store, field, variables);
    } else if (field.name === 'reopenPullRequest' && document.kind === 'mutation') {
      data[field.alias] = reopenPullRequest(store, field, variables);
    } else if (field.name === 'addComment' && document.kind === 'mutation') {
      data[field.alias] = addComment(store, field, variables);
    } else {
      unknownField(field.name, document.kind === 'mutation' ? 'Mutation' : 'Query');
    }
  }
  return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function operationResponse(store: Store, payload: unknown): Record<string, unknown> {
  if (!isRecord(payload) || typeof payload.query !== 'string') return { errors: [{ message: 'Bad Request' }] };
  const variables = isRecord(payload.variables) ? payload.variables as Record<string, Resolved> : {};
  let document: Document;
  try {
    document = new Parser(tokenize(payload.query)).parse();
  } catch {
    return { errors: [{ message: 'Bad Request' }] };
  }
  try {
    return { data: execute(store, document, variables) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Bad Request';
    return { errors: [{ message }] };
  }
}

export function handleGraphQL(store: Store, args: GraphQLArgs | string, res: ServerResponse): void {
  const method = typeof args === 'string' ? 'POST' : args.method;
  const body = typeof args === 'string' ? args : args.body;
  if (method !== 'POST') {
    sendJson(res, 405, { errors: [{ message: 'Method Not Allowed' }] });
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Bad Request' }] });
    return;
  }
  if (Array.isArray(payload)) {
    sendJson(res, 200, payload.map((operation) => operationResponse(store, operation)));
    return;
  }
  if (!isRecord(payload) || typeof payload.query !== 'string') {
    sendJson(res, 400, { errors: [{ message: 'Bad Request' }] });
    return;
  }
  sendJson(res, 200, operationResponse(store, payload));
}

export const handleGraphql = handleGraphQL;