import { Store, bumpRepoCache, hashObject } from "./store.ts";
import type { Repo } from "./store.ts";
import { isAncestor } from "./git.ts";

export const MCP_PATH = "/mcp";

export interface McpArgs {
  method: string;
  body: string;
  token: string;
  headers: Record<string, string>;
  store: Store;
}

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

function parseBody(raw: string): any {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function rpcResult(id: any, result: any): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: any, code: number, message: string, data?: any): string {
  const obj: any = { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
  if (data !== undefined) obj.error.data = data;
  return JSON.stringify(obj);
}

function toolResult(id: any, value: any): string {
  return rpcResult(id, {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  });
}

function repoResult(repo: Repo): any {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: repo.owner,
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    size: repo.size,
    head_oid: repo.headOid,
  };
}
async function collectBody(request: any): Promise<string> {
  if (!request) return "";
  if (request.body) {
    if (typeof request.body === "string") return request.body;
    if (Buffer.isBuffer(request.body)) return request.body.toString("utf8");
  }
  return new Promise<string>((resolve) => {
    let chunks: Buffer[] = [];
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", finish);
    request.on("error", finish);
    if (request.readableEnded) finish();
  });
}

function respond(response: any, status: number, body: string): void {
  if (response && typeof response.setHeader === "function") {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("x-github-request-id", String(++(response as any).__mcpReq || 1));
  }
  if (response && typeof response.writeHead === "function") {
    response.writeHead(status);
  } else if (response && typeof response.statusCode === "number") {
    response.statusCode = status;
  }
  if (response && typeof response.end === "function") response.end(body);
}

function isJsonRpcRequest(msg: any): msg is RpcRequest {
  return msg && typeof msg === "object" && msg.jsonrpc === "2.0" && typeof msg.method === "string";
}

function listTools(): any {
  return [
    {
      name: "repos/create",
      description: "Create a new repository.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          private: { type: "boolean" },
          default_branch: { type: "string" },
        },
        required: ["owner", "name"],
      },
    },
    {
      name: "repos/list",
      description: "List repositories visible to the viewer.",
      inputSchema: {
        type: "object",
        properties: {
          per_page: { type: "number" },
          page: { type: "number" },
        },
      },
    },
    {
      name: "repos/get",
      description: "Get a repository by full name.",
      inputSchema: {
        type: "object",
        properties: { full_name: { type: "string" } },
        required: ["full_name"],
      },
    },
    {
      name: "branches/list",
      description: "List branches of a repository.",
      inputSchema: {
        type: "object",
        properties: { full_name: { type: "string" } },
        required: ["full_name"],
      },
    },
    {
      name: "commits/list",
      description: "List commits on a branch of a repository.",
      inputSchema: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          branch: { type: "string" },
          per_page: { type: "number" },
        },
        required: ["full_name"],
      },
    },
    {
      name: "issues/create",
      description: "Create an issue in a repository.",
      inputSchema: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          labels: { type: "array", items: { type: "string" } },
        },
        required: ["full_name", "title"],
      },
    },
    {
      name: "issues/list",
      description: "List issues of a repository.",
      inputSchema: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "all"] },
        },
        required: ["full_name"],
      },
    },
    {
      name: "issues/get",
      description: "Get a single issue by number.",
      inputSchema: {
        type: "object",
        properties: { full_name: { type: "string" }, number: { type: "number" } },
        required: ["full_name", "number"],
      },
    },
    {
      name: "issues/comments",
      description: "List comments on an issue.",
      inputSchema: {
        type: "object",
        properties: { full_name: { type: "string" }, number: { type: "number" } },
        required: ["full_name", "number"],
      },
    },
    {
      name: "issues/add_comment",
      description: "Add a comment to an issue.",
      inputSchema: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          number: { type: "number" },
          body: { type: "string" },
        },
        required: ["full_name", "number", "body"],
      },
    },
    {
      name: "pulls/create",
      description: "Create a pull request in a repository.",
      inputSchema: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          head: { type: "string" },
          base: { type: "string" },
        },
        required: ["full_name", "title", "head", "base"],
      },
    },
    {
      name: "pulls/list",
      description: "List pull requests of a repository.",
      inputSchema: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "all"] },
        },
        required: ["full_name"],
      },
    },
    {
      name: "pulls/get",
      description: "Get a single pull request by number.",
      inputSchema: {
        type: "object",
        properties: { full_name: { type: "string" }, number: { type: "number" } },
        required: ["full_name", "number"],
      },
    },
    {
      name: "pulls/merge",
      description: "Merge a pull request.",
      inputSchema: {
        type: "object",
        properties: { full_name: { type: "string" }, number: { type: "number" } },
        required: ["full_name", "number"],
      },
    },
  ];
}

function listToolsResult(): string {
  return rpcResult(null, { tools: listTools() });
}

function issueObject(repo: Repo, n: number): any {
  const issue = repo.issueByNumber && repo.issueByNumber.get(n);
  if (!issue) return null;
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user.login },
    labels: issue.labels.map((l: any) => ({ name: l.name, color: l.color })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

function pullObject(repo: Repo, n: number): any {
  const pull = repo.pullByNumber && repo.pullByNumber.get(n);
  if (!pull) return null;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: pull.head,
    base: pull.base,
    user: { login: pull.user.login },
    labels: pull.labels.map((l: any) => ({ name: l.name, color: l.color })),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
  };
}

function commentObject(c: any): any {
  return {
    id: c.id,
    body: c.body,
    user: { login: c.user.login },
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

function repoBranchList(repo: Repo): any[] {
  const out: any[] = [];
  for (const [ref, oid] of repo.refs.entries()) {
    if (ref.startsWith("refs/heads/")) {
      out.push({ name: ref.slice("refs/heads/".length), commit: { sha: oid } });
    }
  }
  return out;
}

function repoCommitList(repo: Repo, branch: string | undefined, perPage: number): any[] {
  let oid = repo.headOid;
  if (branch) {
    const refOid = repo.refs.get("refs/heads/" + branch);
    if (refOid) oid = refOid;
  }
  if (!oid) return [];
  const commits: any[] = [];
  const seen = new Set<string>();
  const stack: string[] = [oid];
  while (stack.length && commits.length < perPage) {
    const cur = stack.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== "commit") continue;
    const text = obj.data.toString("utf8");
    const body = text.split(/\n\n/, 2);
    let msg = text;
    if (body.length > 1) msg = body[1].trimEnd();
    commits.push({ sha: cur, message: msg });
    const parentMatch = text.match(/^parent ([0-9a-f]{40})$/gm);
    if (parentMatch) {
      for (let i = parentMatch.length - 1; i >= 0; i--) {
        stack.push(parentMatch[i].slice(7));
      }
    }
  }
  return commits;
}

function findRepo(store: Store, fullName: string): Repo | undefined {
  return store.repos.get(fullName) || store.repos.get("adaiversen/" + fullName);
}

function toolReposCreate(id: any, store: Store, p: any): string {
  const owner = String(p.owner || "adaiversen");
  const name = String(p.name);
  const repo = store.createRepo(owner, name, {
    description: p.description !== undefined ? String(p.description) : undefined,
    isPrivate: p.private !== undefined ? Boolean(p.private) : undefined,
    defaultBranch: p.default_branch !== undefined ? String(p.default_branch) : undefined,
  });
  return toolResult(id, repoResult(repo));
}

function toolReposList(id: any, store: Store, p: any): string {
  const repos = [...store.repos.values()].map(repoResult);
  return toolResult(id, repos);
}

function toolReposGet(id: any, store: Store, p: any): string {
  const repo = findRepo(store, String(p.full_name || ""));
  if (!repo) return rpcError(id, -32002, "Repository not found: " + p.full_name);
  return toolResult(id, repoResult(repo));
}

function toolBranchesList(id: any, store: Store, p: any): string {
  const repo = findRepo(store, String(p.full_name || ""));
  if (!repo) return rpcError(id, -32002, "Repository not found: " + p.full_name);
  return toolResult(id, repoBranchList(repo));
}

function toolCommitsList(id: any, store: Store, p: any): string {
  const repo = findRepo(store, String(p.full_name || ""));
  if (!repo) return rpcError(id, -32002, "Repository not found: " + p.full_name);
  const perPage = Math.max(1, Math.min(100, Number(p.per_page) || 30));
  const branch = p.branch !== undefined ? String(p.branch) : undefined;
  return toolResult(id, repoCommitList(repo, branch, perPage));
}

function toolIssuesCreate(id: any, store: Store, p: any): string {
  const repo = findRepo(store, String(p.full_name || ""));
  if (!repo) return rpcError(id, -32002, "Repository not found: " + p.full_name);
  const title = String(p.title);
  const body = p.body !== undefined ? String(p.body) : "";
  const labels = Array.isArray(p.labels) ? p.labels.map(String) : [];
  const labelsArr: any[] = [];
  if (labels.length) {
    for (const ln of labels) {
      const lab = repo.labels.find((l: any) => l.name === ln);
      if (lab) labelsArr.push(lab);
    }
  }
  const issue = {
    id: store.nextIssueId++,
    number: repo.issues.length + 1,
    user: store.viewer,
    title,
    body,
    state: "open",
    labels: labelsArr,
    createdAt: store.nowIso,
    updatedAt: store.nowIso,
    closedAt: null,
    comments: [],
  };
  repo.issues.push(issue);
  repo.issueByNumber.set(issue.number, issue);
  bumpRepoCache(repo);
  return toolResult(id, issueObject(repo, issue.number));
}

function toolIssuesList(id: any, store: Store, p: any): string {
  const repo = findRepo(store, String(p.full_name || ""));
  if (!repo) return rpcError(id, -32002, "Repository not found: " + p.full_name);
  const state = p.state !== undefined ? String(p.state) : "open";
  const out = repo.issues
    .filter((i: any) => state === "all" || i.state === state)
    .map((i: any) => issueObject(repo, i.number));
  return toolResult(id, out);
}

function toolIssuesGet(id: any, store: Store, p: any): string {
  const repo = findRepo(store, String(p.full_name || ""));
  if (!repo) return rpcError(id, -32002, "Repository not found: " + p.full_name);
  const obj = issueObject(repo, Number(p.number));
  if (!obj) return rpcError(id, -32002, "Issue not found: " + p.number);
  return toolResult(id, obj);
}

function toolIssuesComments(id: any, store: Store, p: any): string {
  const repo = findRepo(store, String(p.full_name || ""));
  if (!repo) return rpcError(id, -32002, "Repository not found: " + p.full_name);
  const issue = repo.issueByNumber.get(Number(p.number));
  if (!issue) return rpcError(id, -32002, "Issue not found: " + p.number);
  return toolResult(id, issue.comments.map(commentObject));
}

function toolIssuesAddComment(id: any, store: Store, p: any): string {
  const repo = findRepo(store, String(p.full_name || ""));
  if (!repo) return rpcError(id, -32002, "Repository not found: " + p.full_name);
  const issue = repo.issueByNumber.get(Number(p.number));
  if (!issue) return rpcError(id, -32002, "Issue not found: " + p.number);
  const comment = {
    id: store.nextCommentId++,
    user: store.viewer,
    createdAt: store.nowIso,
    updatedAt: store.nowIso,
    body: String(p.body || ""),
  };
  issue.comments.push(comment);
  issue.updatedAt = store.nowIso;
  bumpRepoCache(repo);
  return toolResult(id, commentObject(comment));
}

function toolPullsCreate(id: any, store: Store, p: any): string {
  const repo = findRepo(store, String(p.full_name || ""));
  if (!repo) return rpcError(id, -32002, "Repository not found: " + p.full_name);
  const title = String(p.title);
  const body = p.body !== undefined ? String(p.body) : "";
  const head = String(p.head);
  const base = String(p.base);
  const pull = {
    id: store.nextPullId++,
    number: repo.pulls.length + 1,
    user: store.viewer,
    title,
    body,
    state: "open",
    head,
    base,
    labels: [],
    createdAt: store.nowIso,
    updatedAt: store.nowIso,
    closedAt: null,
    comments: [],
  };
  repo.pulls.push(pull);
  repo.pullByNumber.set(pull.number, pull);
  bumpRepoCache(repo);
  return toolResult(id, pullObject(repo, pull.number));
}

function toolPullsList(id: any, store: Store, p: any): string {
  const repo = findRepo(store, String(p.full_name || ""));
  if (!repo) return rpcError(id, -32002, "Repository not found: " + p.full_name);
  const state = p.state !== undefined ? String(p.state) : "open";
  const out = repo.pulls
    .filter((pl: any) => state === "all" || pl.state === state)
    .map((pl: any) => pullObject(repo, pl.number));
  return toolResult(id, out);
}

function toolPullsGet(id: any, store: Store, p: any): string {
  const repo = findRepo(store, String(p.full_name || ""));
  if (!repo) return rpcError(id, -32002, "Repository not found: " + p.full_name);
  const obj = pullObject(repo, Number(p.number));
  if (!obj) return rpcError(id, -32002, "Pull not found: " + p.number);
  return toolResult(id, obj);
}

function toolPullsMerge(id: any, store: Store, p: any): string {
  const repo = findRepo(store, String(p.full_name || ""));
  if (!repo) return rpcError(id, -32002, "Repository not found: " + p.full_name);
  const pull = repo.pullByNumber.get(Number(p.number));
  if (!pull) return rpcError(id, -32002, "Pull not found: " + p.number);
  if (pull.state !== "open") {
    return toolResult(id, { sha: null, merged: false, message: "Pull request is not open" });
  }
  const baseOid = repo.refs.get("refs/heads/" + pull.base);
  const headOid = repo.refs.get("refs/heads/" + pull.head);
  if (!baseOid || !headOid) {
    return toolResult(id, { sha: null, merged: false, message: "Branch not found" });
  }
  const lookup = (o: string) => repo.objects.get(o);
  if (!isAncestor(baseOid, headOid, lookup)) {
    return toolResult(id, { sha: null, merged: false, message: "Not an ancestor of the base" });
  }
  const commitText =
    "tree " + treeOidOf(repo, headOid) + "\n" +
    "parent " + baseOid + "\n" +
    "author Ada Iversen <adaiversen@example.invalid> 1700000000 +0000\n" +
    "committer Ada Iversen <adaiversen@example.invalid> 1700000000 +0000\n" +
    "\nMerge pull request #" + pull.number + "\n";
  const mergeOid = hashObject("commit", Buffer.from(commitText, "utf8"));
  repo.objects.set(mergeOid, { type: "commit", data: Buffer.from(commitText, "utf8") });
  repo.refs.set("refs/heads/" + pull.base, mergeOid);
  repo.headOid = mergeOid;
  repo.pushedAt = store.nowIso;
  repo.updatedAt = store.nowIso;
  pull.merged = true;
  pull.state = "closed";
  pull.mergeCommitSha = mergeOid;
  pull.updatedAt = store.nowIso;
  pull.closedAt = store.nowIso;
  bumpRepoCache(repo);
  return toolResult(id, { sha: mergeOid, merged: true, message: "Pull request successfully merged" });
}

function treeOidOf(repo: Repo, commitOid: string): string {
  const obj = repo.objects.get(commitOid);
  if (!obj) return "0000000000000000000000000000000000000000";
  const text = obj.data.toString("utf8");
  const m = text.match(/^tree ([0-9a-f]{40})$/m);
  return m ? m[1] : "0000000000000000000000000000000000000000";
}

function dispatchTool(store: Store, id: any, name: string, params: any): string {
  const p = params && typeof params === "object" ? params : {};
  const def = listTools().find((t: any) => t.name === name);
  if (def) {
    const required = Array.isArray(def.inputSchema && def.inputSchema.required) ? def.inputSchema.required : [];
    for (const r of required) {
      if (p[r] === undefined || p[r] === null || p[r] === "") {
        return rpcError(id, -32602, "Missing required argument: " + r);
      }
    }
  }
  switch (name) {
    case "repos/create": return toolReposCreate(id, store, p);
    case "repos/list": return toolReposList(id, store, p);
    case "repos/get": return toolReposGet(id, store, p);
    case "branches/list": return toolBranchesList(id, store, p);
    case "commits/list": return toolCommitsList(id, store, p);
    case "issues/create": return toolIssuesCreate(id, store, p);
    case "issues/list": return toolIssuesList(id, store, p);
    case "issues/get": return toolIssuesGet(id, store, p);
    case "issues/comments": return toolIssuesComments(id, store, p);
    case "issues/add_comment": return toolIssuesAddComment(id, store, p);
    case "pulls/create": return toolPullsCreate(id, store, p);
    case "pulls/list": return toolPullsList(id, store, p);
    case "pulls/get": return toolPullsGet(id, store, p);
    case "pulls/merge": return toolPullsMerge(id, store, p);
    default: return rpcError(id, -32601, "Method not found: " + name);
  }
}

function handleRpc(store: Store, msg: RpcRequest): string {
  const method = msg.method;
  const id = msg.id;
  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "github-core-clone-mcp", version: "1.0.0" },
    });
  }
  if (method === "notifications/initialized") {
    return "";
  }
  if (method === "tools/list") {
    return rpcResult(id, { tools: listTools() });
  }
  if (method === "tools/call") {
    const params = msg.params || {};
    const name = params.name;
    const args = params.arguments || {};
    return dispatchTool(store, id, name, args);
  }
  return rpcError(id, -32601, "Method not found: " + method);
}

function writeResponse(response: any, status: number, body: string, contentType: string): void {
  if (!response) return;
  if (typeof response.writeHead === "function") {
    response.writeHead(status, {
      "Content-Type": contentType,
      "Content-Length": Buffer.byteLength(body),
      "x-github-request-id": String(++(response as any).__reqCounter || 0),
    });
  } else if (typeof response.statusCode === "number") {
    response.statusCode = status;
  }
  if (typeof response.end === "function") response.end(body);
}

export async function handleMcp(args: McpArgs, request: any, response: any): Promise<void> {
  if (args.method !== "POST") {
    writeResponse(response, 405, JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method Not Allowed" } }), "application/json");
    return;
  }
  let raw: string;
  try {
    raw = await collectBody(request);
  } catch {
    raw = "";
  }
  const parsed = parseBody(raw);
  if (!isJsonRpcRequest(parsed)) {
    const bad = parseBody(raw);
    if (bad && typeof bad === "object") {
      writeResponse(response, 200, rpcError(bad.id, -32700, "Parse error"), "application/json");
    } else {
      writeResponse(response, 200, rpcError(null, -32700, "Parse error"), "application/json");
    }
    return;
  }
  const out = handleRpc(args.store, parsed);
  if (out === "") {
    writeResponse(response, 202, "", "application/json");
    return;
  }
  writeResponse(response, 200, out, "application/json");
}

export const handleMCP = handleMcp;
