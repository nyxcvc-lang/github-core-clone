// Model Context Protocol over POST /mcp (JSON-RPC 2.0, Streamable HTTP).
// Speaks both eras: modern 2026-07-28 via server/discover, and legacy 2025-11-25 via
// initialize + notifications/initialized. Six tools on the same store as REST/GraphQL.
// No auth -> HTTP 401. A body that is not JSON -> HTTP 400 with JSON-RPC -32700.
// Unknown tool -> -32602. Missing required arguments -> isError:true.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Pull, Repo, Store } from './store.ts';

const SERVER_NAME = 'github-core-clone-01-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch to a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

// The tools/list result, built once: two calls answer byte-identical bytes.
const TOOLS_RESULT: { tools: McpToolDef[] } = { tools: TOOLS };

interface ToolContext {
  store: Store;
  viewerLogin: string;
}

type ToolResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

function repoJson(ctx: ToolContext, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: ctx.store.repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(ctx: ToolContext, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: ctx.store.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
  };
}

function pullJson(ctx: ToolContext, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: ctx.store.pullGlobalId(repo, pull),
    number: pull.number,
    pull_number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    head: pull.head,
    base: pull.base,
    head_ref: pull.head,
    base_ref: pull.base,
  };
}

function callTool(ctx: ToolContext, name: string, args: Record<string, unknown>): ToolResult {
  const store = ctx.store;
  const lookupRepo = (): Repo | null => {
    const owner = typeof args.owner === 'string' ? args.owner : '';
    const repo = typeof args.repo === 'string' ? args.repo : '';
    const found = owner === '' || repo === '' ? undefined : store.getRepo(owner, repo);
    return found === undefined ? null : found;
  };
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '') return { ok: false, message: 'missing required argument: name' };
      const repo = store.createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      if (repo === null) return { ok: false, message: `repository ${repoName} already exists` };
      return { ok: true, value: repoJson(ctx, repo) };
    }
    case 'get_repo': {
      const repo = lookupRepo();
      if (repo === null) return { ok: false, message: 'repository not found' };
      return { ok: true, value: repoJson(ctx, repo) };
    }
    case 'create_issue': {
      const repo = lookupRepo();
      if (repo === null) return { ok: false, message: 'repository not found' };
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return { ok: false, message: 'missing required argument: title' };
      const issue = store.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
      return { ok: true, value: issueJson(ctx, repo, issue) };
    }
    case 'list_issues': {
      const repo = lookupRepo();
      if (repo === null) return { ok: false, message: 'repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'all';
      const items = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return { ok: true, value: items.map((issue) => issueJson(ctx, repo, issue)) };
    }
    case 'create_pull_request': {
      const repo = lookupRepo();
      if (repo === null) return { ok: false, message: 'repository not found' };
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (title === '' || head === '' || base === '') return { ok: false, message: 'missing required argument: title, head or base' };
      let pull = repo.pulls.find((candidate) => candidate.state === 'open' && !candidate.merged && candidate.head === head && candidate.base === base);
      if (pull === undefined) {
        const created = store.createPull(repo, head, base, title, typeof args.body === 'string' ? args.body : '');
        if (created === null) return { ok: false, message: `cannot create pull request from ${head} to ${base}` };
        pull = created;
      }
      return { ok: true, value: pullJson(ctx, repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = lookupRepo();
      if (repo === null) return { ok: false, message: 'repository not found' };
      const number = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : NaN;
      if (!Number.isFinite(number)) return { ok: false, message: 'missing required argument: pull_number' };
      const pull = store.findPull(repo, number);
      if (pull === undefined) return { ok: false, message: `pull request ${number} not found` };
      if (pull.merged) return { ok: true, value: pullJson(ctx, repo, pull) };
      const plan = store.mergePlan(repo, pull);
      if (plan.conflict) return { ok: false, message: 'merge conflict' };
      const mergeOid = store.doMerge(repo, pull);
      if (mergeOid === null) return { ok: false, message: 'merge conflict' };
      pull.merged = true;
      pull.mergedAt = '2025-01-01T00:00:00Z';
      pull.mergeSha = mergeOid;
      pull.state = 'closed';
      return { ok: true, value: pullJson(ctx, repo, pull) };
    }
    default:
      return { ok: false, message: `unknown tool ${name}` };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** POST /mcp. `rawBody` is the exact request bytes (parse errors need the raw text). */
export function handleMcp(
  ctx: ToolContext,
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: Buffer,
): void {
  const requestId = ctx.store.requestId();
  const send = (status: number, payload: unknown, extra: Record<string, string> = {}): void => {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-github-request-id': requestId,
      'content-length': Buffer.byteLength(text),
      ...extra,
    });
    res.end(text);
  };
  // A body that is not JSON answers HTTP 400 with JSON-RPC -32700.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  // Auth (checked after the parse, so a bad body still answers -32700).
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token !== '') {
    const header = req.headers.authorization ?? '';
    if (header !== `Bearer ${token}`) {
      const id = isRecord(parsed) && (typeof parsed.id === 'string' || typeof parsed.id === 'number') ? parsed.id : null;
      send(401, { jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } });
      return;
    }
  }
  const handleOne = (request: unknown): unknown => {
    if (!isRecord(request)) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const id = request.id ?? null;
    const method = typeof request.method === 'string' ? request.method : '';
    const params = isRecord(request.params) ? request.params : {};
    const result = (value: unknown): unknown => ({ jsonrpc: '2.0', id, result: value });
    const error = (code: number, message: string): unknown => ({ jsonrpc: '2.0', id, error: { code, message } });
    // Notifications carry no id and are answered with an empty 202 by the caller.
    if (id === null && method.startsWith('notifications/')) return null;
    switch (method) {
      case 'server/discover':
        return result({
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
        });
      case 'initialize': {
        const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
        return result({
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      }
      case 'ping':
        return result({});
      case 'tools/list':
        return result(TOOLS_RESULT);
      case 'tools/call': {
        const toolName = typeof params.name === 'string' ? params.name : '';
        const args = isRecord(params.arguments) ? params.arguments : {};
        const def = TOOLS.find((tool) => tool.name === toolName);
        if (def === undefined) return error(-32602, `unknown tool ${toolName}`);
        const required = (def.inputSchema.required as string[] | undefined) ?? [];
        const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
        if (missing.length > 0) {
          return result({
            content: [{ type: 'text', text: `missing required argument: ${missing.join(', ')}` }],
            isError: true,
          });
        }
        const outcome = callTool(ctx, toolName, args);
        if (!outcome.ok) {
          return result({
            content: [{ type: 'text', text: outcome.message }],
            isError: true,
          });
        }
        return result({
          content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
          structuredContent: outcome.value,
        });
      }
      default:
        return error(-32601, `method not found: ${method}`);
    }
  };
  if (Array.isArray(parsed)) {
    const responses = parsed.map(handleOne).filter((response) => response !== null);
    send(200, responses);
    return;
  }
  const response = handleOne(parsed);
  if (response === null) {
    // A notification: no JSON-RPC response, HTTP 202 with an empty body.
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }
  send(200, response);
}
