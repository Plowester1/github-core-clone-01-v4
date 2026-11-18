import type { ServerResponse } from 'node:http';
import { commitList, commitView, createRepo, diffTrees, findPath, getRepo, mergeTrees, putCommit, sendJson } from './rest.ts';
import { bumpRepoCache, type Store, type Repo, type Issue, type Pull, type Comment } from './store.ts';

export const MCP_PATH = '/mcp';

export interface McpArgs {
  method: string;
  body: string;
  headers?: Record<string, string | string[] | undefined>;
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

type ToolArgs = Record<string, unknown>;

const OWNER = { type: 'string', description: 'Repository owner login' };
const REPO = { type: 'string', description: 'Repository name' };

function tool(name: string, description: string, properties: ToolSpec['inputSchema']['properties'], required: string[] = []): ToolSpec {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const BASE_TOOLS: ToolSpec[] = [
  tool('create_repository', 'Create a repository', { owner: OWNER, name: { type: 'string', description: 'New repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, ['owner', 'name']),
  tool('list_repositories', 'List repositories', { owner: OWNER }, []),
  tool('get_repository', 'Get a repository', { owner: OWNER, repo: REPO }, ['owner', 'repo']),
  tool('list_branches', 'List branches', { owner: OWNER, repo: REPO }, ['owner', 'repo']),
  tool('list_commits', 'List commits', { owner: OWNER, repo: REPO, ref: { type: 'string', description: 'Branch, tag, or commit SHA' } }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue', { owner: OWNER, repo: REPO, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues', { owner: OWNER, repo: REPO, state: { type: 'string', description: 'Issue state' } }, ['owner', 'repo']),
  tool('get_issue', 'Get an issue', { owner: OWNER, repo: REPO, number: { type: 'integer', description: 'Issue number' } }, ['owner', 'repo', 'number']),
  tool('create_comment', 'Create an issue comment', { owner: OWNER, repo: REPO, number: { type: 'integer', description: 'Issue number' }, body: { type: 'string', description: 'Comment body' } }, ['owner', 'repo', 'number', 'body']),
  tool('list_comments', 'List issue comments', { owner: OWNER, repo: REPO, number: { type: 'integer', description: 'Issue number' } }, ['owner', 'repo', 'number']),
  tool('create_pull_request', 'Create a pull request', { owner: OWNER, repo: REPO, head: { type: 'string', description: 'Head branch' }, base: { type: 'string', description: 'Base branch' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string', description: 'Pull request body' } }, ['owner', 'repo', 'head', 'base', 'title']),
  tool('list_pull_requests', 'List pull requests', { owner: OWNER, repo: REPO, state: { type: 'string', description: 'Pull request state' } }, ['owner', 'repo']),
  tool('get_pull_request', 'Get a pull request', { owner: OWNER, repo: REPO, number: { type: 'integer', description: 'Pull request number' } }, ['owner', 'repo', 'number']),
  tool('merge_pull_request', 'Merge a pull request', { owner: OWNER, repo: REPO, number: { type: 'integer', description: 'Pull request number' } }, ['owner', 'repo', 'number']),
  tool('get_file_contents', 'Get a file', { owner: OWNER, repo: REPO, path: { type: 'string', description: 'File path' }, ref: { type: 'string', description: 'Branch, tag, or commit' } }, ['owner', 'repo', 'path']),
];

const TOOL_ALIASES: Record<string, string> = {
  create_repo: 'create_repository',
  list_repos: 'list_repositories',
  get_repo: 'get_repository',
  create_pr: 'create_pull_request',
  list_prs: 'list_pull_requests',
  get_pr: 'get_pull_request',
  merge_pr: 'merge_pull_request',
};

const TOOL_SPECS: ToolSpec[] = [...BASE_TOOLS];
for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
  const source = BASE_TOOLS.find((item) => item.name === canonical);
  if (source !== undefined) TOOL_SPECS.push({ ...source, name: alias, inputSchema: { ...source.inputSchema, properties: { ...source.inputSchema.properties } } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(args: ToolArgs, names: string[]): unknown {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(args, name) && args[name] !== undefined) return args[name];
  }
  return undefined;
}

function requiredText(args: ToolArgs, names: string[]): string {
  const value = pick(args, names);
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`Missing required argument: ${names[0]}`);
  return String(value);
}

function optionalText(args: ToolArgs, names: string[], fallback = ''): string {
  const value = pick(args, names);
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`Invalid argument: ${names[0]}`);
  return String(value);
}

function requiredNumber(args: ToolArgs, names: string[]): number {
  const value = pick(args, names);
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number)) throw new Error(`Missing required argument: ${names[0]}`);
  return number;
}

function lookupRepo(store: Store, args: ToolArgs): Repo {
  const owner = optionalText(args, ['owner', 'owner_login'], store.viewer.login);
  const name = requiredText(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name', 'name']);
  const repo = getRepo(store, owner, name);
  if (repo === null) throw new Error(`Repository not found: ${owner}/${name}`);
  return repo;
}

function repoValue(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: repo.owner.login,
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueValue(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: issue.user.login,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullValue(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: pull.user.login,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner.login}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner.login}:${pull.base}` },
    merged: pull.merged,
    mergeable: pull.mergeable,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    merged_at: pull.mergedAt,
  };
}

function commentValue(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: comment.user.login,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function callCreateRepository(store: Store, args: ToolArgs): unknown {
  const owner = optionalText(args, ['owner', 'owner_login'], store.viewer.login);
  const user = store.users.get(owner) ?? store.viewer;
  const name = requiredText(args, ['name', 'repository_name', 'repository', 'repo_name']);
  const description = optionalText(args, ['description']);
  const privateRepo = args.private === true || args.private_repo === true;
  const { repo } = createRepo(store, user, name, description, privateRepo, false);
  return repoValue(repo);
}

function callListRepositories(store: Store, args: ToolArgs): unknown {
  const owner = optionalText(args, ['owner', 'owner_login'], '');
  const repos = [...store.repos.values()].filter((repo) => owner === '' || repo.owner.login === owner);
  return repos.map(repoValue);
}

function callGetRepository(store: Store, args: ToolArgs): unknown {
  return repoValue(lookupRepo(store, args));
}

function callListBranches(store: Store, args: ToolArgs): unknown {
  const repo = lookupRepo(store, args);
  return [...repo.refs.entries()].filter(([name]) => name.startsWith('refs/heads/')).map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), sha }));
}

function callListCommits(store: Store, args: ToolArgs): unknown {
  const repo = lookupRepo(store, args);
  const ref = optionalText(args, ['ref', 'branch', 'sha'], repo.defaultBranch);
  const tip = repo.refs.get(`refs/heads/${ref}`) ?? (repo.objects.has(ref) ? ref : repo.refs.get(`refs/heads/${repo.defaultBranch}`));
  if (tip === undefined) throw new Error(`Branch not found: ${ref}`);
  return commitList(repo, tip).map((oid) => ({ sha: oid, message: commitView(repo, oid)?.message ?? '', url: '' }));
}

function callCreateIssue(store: Store, args: ToolArgs): unknown {
  const repo = lookupRepo(store, args);
  const title = requiredText(args, ['title']);
  const body = optionalText(args, ['body']);
  const number = repo.issues.length + 1;
  const issue: Issue = { id: store.nextIssueId, number, title, body, user: store.viewer, state: 'open', labels: [], createdAt: store.nowIso, updatedAt: store.nowIso, comments: [] };
  store.nextIssueId += 1;
  repo.issues.push(issue);
  repo.issueByNumber.set(number, issue);
  repo.updatedAt = store.nowIso;
  return issueValue(issue);
}

function callListIssues(store: Store, args: ToolArgs): unknown {
  const repo = lookupRepo(store, args);
  const state = optionalText(args, ['state'], 'open');
  return repo.issues.filter((issue) => state === 'all' || issue.state === state).map(issueValue);
}

function callGetIssue(store: Store, args: ToolArgs): unknown {
  const repo = lookupRepo(store, args);
  const number = requiredNumber(args, ['number', 'issue_number', 'issue']);
  const issue = repo.issueByNumber.get(number);
  if (issue === undefined) throw new Error(`Issue not found: ${number}`);
  return issueValue(issue);
}

function callCreateComment(store: Store, args: ToolArgs): unknown {
  const repo = lookupRepo(store, args);
  const number = requiredNumber(args, ['number', 'issue_number', 'issue', 'subject_id']);
  const issue = repo.issueByNumber.get(number);
  if (issue === undefined) throw new Error(`Issue not found: ${number}`);
  const comment: Comment = { id: store.nextCommentId, user: store.viewer, body: requiredText(args, ['body']), createdAt: store.nowIso, updatedAt: store.nowIso };
  store.nextCommentId += 1;
  issue.comments.push(comment);
  issue.updatedAt = store.nowIso;
  return commentValue(comment);
}

function callListComments(store: Store, args: ToolArgs): unknown {
  const repo = lookupRepo(store, args);
  const number = requiredNumber(args, ['number', 'issue_number', 'issue']);
  const issue = repo.issueByNumber.get(number);
  if (issue === undefined) throw new Error(`Issue not found: ${number}`);
  return issue.comments.map(commentValue);
}

function callGetFileContents(store: Store, args: ToolArgs): unknown {
  const repo = lookupRepo(store, args);
  const path = requiredText(args, ['path', 'file_path']).replace(/^\/+/, '');
  const ref = optionalText(args, ['ref', 'branch'], repo.defaultBranch);
  const tip = repo.refs.get(`refs/heads/${ref}`) ?? (repo.objects.has(ref) ? ref : repo.refs.get(`refs/heads/${repo.defaultBranch}`));
  if (tip === undefined) throw new Error(`Branch not found: ${ref}`);
  const oid = findPath(repo, tip, path.split('/').filter(Boolean));
  if (oid === null) throw new Error(`File not found: ${path}`);
  const object = repo.objects.get(oid);
  if (object === undefined) throw new Error(`File not found: ${path}`);
  return { path, sha: oid, encoding: 'utf-8', content: object.data.toString('utf8') };
}

function callCreatePullRequest(store: Store, args: ToolArgs): unknown {
  const repo = lookupRepo(store, args);
  const head = requiredText(args, ['head', 'head_ref', 'head_ref_name', 'head_branch', 'source_branch']).replace(/^refs\/heads\//, '');
  const base = optionalText(args, ['base', 'base_ref', 'base_ref_name', 'base_branch', 'target_branch'], repo.defaultBranch).replace(/^refs\/heads\//, '');
  const title = requiredText(args, ['title', 'pull_request_title']);
  const body = optionalText(args, ['body', 'pull_request_body']);
  const headOid = repo.refs.get(`refs/heads/${head}`);
  const baseOid = repo.refs.get(`refs/heads/${base}`);
  if (headOid === undefined || baseOid === undefined) throw new Error('No commits between the base and the head');
  const number = repo.pulls.length + 1;
  const id = store.nextPullId;
  store.nextPullId += 1;
  const pull: Pull = { id, number, title, body, user: store.viewer, state: 'open', head, base, headSha: headOid, baseSha: baseOid, mergeCommitSha: null, merged: false, mergeable: true, createdAt: store.nowIso, updatedAt: store.nowIso, mergedAt: null };
  repo.pulls.push(pull);
  repo.pullByNumber.set(number, pull);
  repo.updatedAt = store.nowIso;
  return pullValue(repo, pull);
}

function callListPullRequests(store: Store, args: ToolArgs): unknown {
  const repo = lookupRepo(store, args);
  const state = optionalText(args, ['state'], 'open');
  return repo.pulls.filter((pull) => state === 'all' || pull.state === state).map((pull) => pullValue(repo, pull));
}

function callGetPullRequest(store: Store, args: ToolArgs): unknown {
  const repo = lookupRepo(store, args);
  const number = requiredNumber(args, ['number', 'pull_number', 'pr_number', 'pull_request_number']);
  const pull = repo.pullByNumber.get(number);
  if (pull === undefined) throw new Error(`Pull request not found: ${number}`);
  return pullValue(repo, pull);
}

function callMergePullRequest(store: Store, args: ToolArgs): unknown {
  const repo = lookupRepo(store, args);
  const number = requiredNumber(args, ['number', 'pull_number', 'pr_number', 'pull_request_number']);
  const pull = repo.pullByNumber.get(number);
  if (pull === undefined) throw new Error(`Pull request not found: ${number}`);
  if (pull.state !== 'open') throw new Error('Pull Request is not mergeable');
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (baseTip === undefined || headTip === undefined) throw new Error('Pull Request is not mergeable');
  const baseDiffs = diffTrees(repo, pull.baseSha, baseTip);
  const headDiffs = diffTrees(repo, pull.baseSha, headTip);
  const basePaths = new Set(baseDiffs.map((diff) => diff.filename));
  if (headDiffs.some((diff) => basePaths.has(diff.filename))) throw new Error('Pull Request is not mergeable');
  const mergeTree = mergeTrees(repo, baseTip, headTip, pull.baseSha);
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
  repo.updatedAt = store.nowIso;
  return pullValue(repo, pull);
}

function dispatch(store: Store, name: string, args: ToolArgs): unknown {
  switch (name) {
    case 'create_repository': return callCreateRepository(store, args);
    case 'list_repositories': return callListRepositories(store, args);
    case 'get_repository': return callGetRepository(store, args);
    case 'list_branches': return callListBranches(store, args);
    case 'list_commits': return callListCommits(store, args);
    case 'create_issue': return callCreateIssue(store, args);
    case 'list_issues': return callListIssues(store, args);
    case 'get_issue': return callGetIssue(store, args);
    case 'create_comment': return callCreateComment(store, args);
    case 'list_comments': return callListComments(store, args);
    case 'get_file_contents': return callGetFileContents(store, args);
    case 'create_pull_request': return callCreatePullRequest(store, args);
    case 'list_pull_requests': return callListPullRequests(store, args);
    case 'get_pull_request': return callGetPullRequest(store, args);
    case 'merge_pull_request': return callMergePullRequest(store, args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

interface RpcRequest { id?: unknown; method?: unknown; params?: unknown }

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function handleRpc(store: Store, request: RpcRequest): Record<string, unknown> | null {
  const id = request.id;
  if (typeof request.method !== 'string') return rpcError(id, -32600, 'Invalid Request');
  switch (request.method) {
    case 'initialize': {
      const params = isRecord(request.params) ? request.params : {};
      const protocolVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05';
      return rpcResult(id, { protocolVersion, capabilities: { tools: { listChanged: false }, resources: { listChanged: false } }, serverInfo: { name: 'github-core-clone', version: '1.0.0' } });
    }
    case 'notifications/initialized':
      return null;
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOL_SPECS });
    case 'tools/call': {
      if (!isRecord(request.params) || typeof request.params.name !== 'string') return rpcError(id, -32602, 'Invalid params');
      const name = request.params.name;
      if (!TOOL_SPECS.some((item) => item.name === name)) return rpcError(id, -32601, `Unknown tool: ${name}`);
      const args = isRecord(request.params.arguments) ? request.params.arguments : {};
      try {
        const value = dispatch(store, TOOL_ALIASES[name] ?? name, args);
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(value) }] });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Tool failed';
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true });
      }
    }
    case 'resources/list':
      return rpcResult(id, { resources: [...store.repos.values()].map((repo) => ({ uri: `mcp://repos/${repo.fullName}`, name: repo.fullName, mimeType: 'application/json' })) });
    default:
      return rpcError(id, -32601, `Method not found: ${request.method}`);
  }
}

function sessionId(headers: McpArgs['headers']): string | undefined {
  if (headers === undefined) return undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'mcp-session-id') return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

export function handleMcp(store: Store, args: McpArgs | string, res: ServerResponse): void {
  const method = typeof args === 'string' ? 'POST' : args.method;
  const body = typeof args === 'string' ? args : args.body;
  const headers = typeof args === 'string' ? undefined : args.headers;
  if (method !== 'POST') {
    sendJson(res, 405, rpcError(null, -32600, 'Method Not Allowed'));
    return;
  }
  const session = sessionId(headers);
  if (session !== undefined) res.setHeader('Mcp-Session-Id', session);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const requests = Array.isArray(payload) ? payload : [payload];
  const responses: Record<string, unknown>[] = [];
  for (const request of requests) {
    if (!isRecord(request)) {
      responses.push(rpcError(null, -32600, 'Invalid Request'));
      continue;
    }
    const response = handleRpc(store, request as RpcRequest);
    if (response !== null) responses.push(response);
  }
  if (responses.length === 0) {
    res.writeHead(204);
    res.end();
    return;
  }
  sendJson(res, 200, Array.isArray(payload) ? responses : responses[0]);
}

export const handleMCP = handleMcp;