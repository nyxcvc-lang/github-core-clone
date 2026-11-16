// GitHub REST v3 surface (/api/v3). Every reply is JSON with a non-empty
// X-GitHub-Request-Id; errors are {message}; unknown routes are JSON 404.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit } from './git.ts';
import { FIXED_ISO, type Issue, type Label, type Pull, type Repo, type Store } from './store.ts';

export interface RestContext {
  store: Store;
  baseUrl: string; // e.g. http://127.0.0.1:4123 — from the request Host header
  viewerLogin: string;
}

function sendJson(ctx: RestContext, res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = status === 204 ? '' : JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': ctx.store.requestId(),
    ...extra,
  };
  if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

function err(ctx: RestContext, res: ServerResponse, status: number, message: string): void {
  sendJson(ctx, res, status, { message });
}

function ownerJson(login: string): Record<string, unknown> {
  return { login, id: 1000, type: 'User', site_admin: false };
}

function repoJson(ctx: RestContext, repo: Repo): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: ctx.store.repoGlobalId(repo),
    name: repo.name,
    full_name: full,
    owner: ownerJson(repo.owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${full}`,
    url: `${ctx.baseUrl}/api/v3/repos/${full}`,
    clone_url: `${ctx.baseUrl}/${full}.git`,
    git_url: `git://${ctx.baseUrl.replace(/^https?:\/\//, '')}/${full}.git`,
    ssh_url: `git@github.com:${full}.git`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    topics: [],
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function issueJson(ctx: RestContext, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: ctx.store.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: ownerJson(issue.user),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'd73a4a', description: label?.description ?? '' };
    }),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(ctx: RestContext, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: ctx.store.pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    mergeable: null,
    user: ownerJson(pull.user),
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

/** Paginate a list; returns the page and the Link header value ('' when one page). */
function paginate<T>(ctx: RestContext, path: string, query: URLSearchParams, items: T[]): { page: T[]; link: string } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? 30) || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  let link = '';
  if (start + perPage < items.length) {
    const next = new URLSearchParams(query);
    next.set('page', String(pageNum + 1));
    next.set('per_page', String(perPage));
    link = `<${ctx.baseUrl}${path}?${next.toString()}>; rel="next"`;
    const lastPage = Math.ceil(items.length / perPage);
    const last = new URLSearchParams(query);
    last.set('page', String(lastPage));
    last.set('per_page', String(perPage));
    link += `, <${ctx.baseUrl}${path}?${last.toString()}>; rel="last"`;
  }
  return { page, link };
}

function linkHeader(link: string): Record<string, string> {
  return link === '' ? {} : { link };
}

type Body = Record<string, unknown>;

function isRecord(value: unknown): value is Body {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Route /api/v3/* (auth already checked by the dispatcher, except root/meta). */
export function handleRest(
  ctx: RestContext,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): void {
  const store = ctx.store;

  // Root and meta.
  if (path === '/api/v3/' || path === '/api/v3') {
    if (method !== 'GET') return err(ctx, res, 405, 'Method Not Allowed');
    return sendJson(ctx, res, 200, {
      current_user_url: `${ctx.baseUrl}/api/v3/user`,
      repository_url: `${ctx.baseUrl}/api/v3/repos/{owner}/{repo}`,
      user_repositories_url: `${ctx.baseUrl}/api/v3/user/repos`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (path === '/api/v3/meta') {
    if (method !== 'GET') return err(ctx, res, 405, 'Method Not Allowed');
    return sendJson(ctx, res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }
  if (path === '/api/v3/user') {
    if (method !== 'GET') return err(ctx, res, 405, 'Method Not Allowed');
    return sendJson(ctx, res, 200, {
      login: ctx.viewerLogin,
      id: 1000,
      node_id: 'U_1000',
      type: 'User',
      name: ctx.viewerLogin,
      email: `${ctx.viewerLogin}@example.invalid`,
    });
  }

  // POST /api/v3/user/repos and GET /api/v3/user/repos.
  if (path === '/api/v3/user/repos') {
    if (method === 'POST') {
      if (!isRecord(body)) return err(ctx, res, 400, 'Invalid JSON');
      const name = asString(body.name);
      if (name === null || name === '') return err(ctx, res, 422, 'name is required');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return err(ctx, res, 422, 'invalid repository name');
      const repo = store.createRepo(name, asString(body.description) ?? '', body.private === true);
      if (repo === null) return err(ctx, res, 422, 'Repository already exists');
      return sendJson(ctx, res, 201, repoJson(ctx, repo));
    }
    if (method === 'GET') {
      const { page, link } = paginate(ctx, path, query, store.listRepos());
      return sendJson(ctx, res, 200, page.map((repo) => repoJson(ctx, repo)), linkHeader(link));
    }
    return err(ctx, res, 405, 'Method Not Allowed');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  const match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (match === null) return err(ctx, res, 404, 'Not Found');
  const owner = decodeURIComponent(match[1] as string);
  const repoName = decodeURIComponent(match[2] as string);
  const rest = match[3] ?? '';
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return err(ctx, res, 404, 'Not Found');
  // A repo under any owner but the viewer is not visible (never 403).
  if (owner !== ctx.viewerLogin) return err(ctx, res, 404, 'Not Found');

  if (rest === '') {
    if (method === 'GET') return sendJson(ctx, res, 200, repoJson(ctx, repo));
    if (method === 'PATCH') {
      if (!isRecord(body)) return err(ctx, res, 400, 'Invalid JSON');
      if (typeof body.description === 'string') repo.description = body.description;
      return sendJson(ctx, res, 200, repoJson(ctx, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return sendJson(ctx, res, 204, null);
    }
    return err(ctx, res, 405, 'Method Not Allowed');
  }

  // Branches.
  if (rest === '/branches') {
    if (method !== 'GET') return err(ctx, res, 405, 'Method Not Allowed');
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .sort()
      .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) } }));
    return sendJson(ctx, res, 200, branches);
  }
  const branchMatch = /^\/branches\/(.+)$/.exec(rest);
  if (branchMatch !== null) {
    if (method !== 'GET') return err(ctx, res, 405, 'Method Not Allowed');
    const branch = decodeURIComponent(branchMatch[1] as string);
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) return err(ctx, res, 404, 'Not Found');
    return sendJson(ctx, res, 200, { name: branch, commit: { sha } });
  }

  // Commits.
  if (rest === '/commits') {
    if (method !== 'GET') return err(ctx, res, 405, 'Method Not Allowed');
    const refParam = query.get('sha');
    const tip = refParam === null ? store.defaultTip(repo) : store.resolveRef(repo, refParam);
    if (tip === null) return sendJson(ctx, res, 200, []);
    const commits = [...store.reachableCommits(repo, [tip])];
    // Newest first: walk the first-parent chain from the tip, then any stragglers.
    const ordered: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = tip;
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      ordered.push(cursor);
      const parents = store.commitParents(repo, cursor);
      cursor = parents.length > 0 ? (parents[0] as string) : null;
    }
    for (const oid of commits) if (!seen.has(oid)) ordered.push(oid);
    const { page, link } = paginate(ctx, path, query, ordered);
    const items = page.map((sha) => {
      const object = repo.objects.get(sha);
      // Commit objects store the message with a trailing newline (git-canonical);
      // the API returns it exactly as the caller wrote it, without that newline.
      const raw = object !== undefined && object.type === 'commit' ? parseCommit(object.data).message : '';
      const message = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
      return { sha, commit: { message } };
    });
    return sendJson(ctx, res, 200, items, linkHeader(link));
  }

  // Git refs.
  if (rest === '/git/refs' && method === 'POST') {
    if (!isRecord(body)) return err(ctx, res, 400, 'Invalid JSON');
    const ref = asString(body.ref);
    const sha = asString(body.sha);
    if (ref === null || !ref.startsWith('refs/') || sha === null || !/^[0-9a-f]{40}$/.test(sha)) {
      return err(ctx, res, 422, 'ref and sha are required');
    }
    if (repo.refs.has(ref)) return err(ctx, res, 422, 'Reference already exists');
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') return err(ctx, res, 422, 'Object does not exist');
    repo.refs.set(ref, sha);
    return sendJson(ctx, res, 201, { ref, object: { sha, type: 'commit' } });
  }
  const refMatch = /^\/git\/refs\/(heads|tags)\/(.+)$/.exec(rest);
  if (refMatch !== null) {
    if (method !== 'GET') return err(ctx, res, 405, 'Method Not Allowed');
    const kind = refMatch[1] as string;
    const name = decodeURIComponent(refMatch[2] as string);
    const sha = repo.refs.get(`refs/${kind}/${name}`);
    if (sha === undefined) return err(ctx, res, 404, 'Not Found');
    return sendJson(ctx, res, 200, { ref: `refs/${kind}/${name}`, object: { sha, type: 'commit' } });
  }

  // Contents.
  const contentsMatch = /^\/contents(\/(.*))?$/.exec(rest);
  if (contentsMatch !== null) {
    const contentPath = decodeURIComponent(contentsMatch[2] ?? '');
    return handleContents(ctx, req, res, method, repo, contentPath, query, body);
  }

  // Labels.
  if (rest === '/labels') {
    if (method !== 'POST') return err(ctx, res, 405, 'Method Not Allowed');
    if (!isRecord(body)) return err(ctx, res, 400, 'Invalid JSON');
    const name = asString(body.name);
    if (name === null || name === '') return err(ctx, res, 422, 'name is required');
    const color = asString(body.color) ?? 'd73a4a';
    const label = store.createLabel(repo, name, color, asString(body.description) ?? '');
    if (label === null) return err(ctx, res, 422, 'Label already exists');
    return sendJson(ctx, res, 201, labelJson(label));
  }

  // Issues.
  if (rest === '/issues') {
    if (method === 'GET') {
      let items = [...repo.issues];
      const state = query.get('state') ?? 'open';
      if (state === 'open') items = items.filter((issue) => issue.state === 'open');
      else if (state === 'closed') items = items.filter((issue) => issue.state === 'closed');
      const direction = query.get('direction') ?? 'desc';
      const sort = query.get('sort') ?? 'created';
      void sort;
      items.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      const { page, link } = paginate(ctx, path, query, items);
      return sendJson(ctx, res, 200, page.map((issue) => issueJson(ctx, repo, issue)), linkHeader(link));
    }
    if (method === 'POST') {
      if (!isRecord(body)) return err(ctx, res, 400, 'Invalid JSON');
      const title = asString(body.title);
      if (title === null || title === '') return err(ctx, res, 422, 'title is required');
      const labels = normalizeLabels(body.labels);
      for (const label of labels) {
        if (!repo.labels.has(label)) return err(ctx, res, 422, `Label ${label} does not exist`);
      }
      const issue = store.createIssue(repo, title, asString(body.body) ?? '', labels);
      return sendJson(ctx, res, 201, issueJson(ctx, repo, issue));
    }
    return err(ctx, res, 405, 'Method Not Allowed');
  }
  const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
  if (issueMatch !== null) {
    const number = Number(issueMatch[1]);
    const issue = store.findIssue(repo, number);
    if (issue === undefined) return err(ctx, res, 404, 'Not Found');
    if (issueMatch[2] === '/comments') {
      if (method === 'GET') {
        const { page, link } = paginate(ctx, path, query, issue.comments);
        return sendJson(ctx, res, 200, page.map((comment) => commentJson(ctx, repo, issue, comment)), linkHeader(link));
      }
      if (method === 'POST') {
        if (!isRecord(body)) return err(ctx, res, 400, 'Invalid JSON');
        const commentBody = asString(body.body);
        if (commentBody === null) return err(ctx, res, 422, 'body is required');
        const comment = store.addComment(issue, commentBody);
        return sendJson(ctx, res, 201, commentJson(ctx, repo, issue, comment));
      }
      return err(ctx, res, 405, 'Method Not Allowed');
    }
    if (method === 'GET') return sendJson(ctx, res, 200, issueJson(ctx, repo, issue));
    if (method === 'PATCH') {
      if (!isRecord(body)) return err(ctx, res, 400, 'Invalid JSON');
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      return sendJson(ctx, res, 200, issueJson(ctx, repo, issue));
    }
    return err(ctx, res, 405, 'Method Not Allowed');
  }

  // Pulls.
  if (rest === '/pulls') {
    if (method === 'GET') {
      let items = [...repo.pulls];
      const state = query.get('state') ?? 'open';
      if (state === 'open') items = items.filter((pull) => pull.state === 'open' && !pull.merged);
      else if (state === 'closed') items = items.filter((pull) => pull.state === 'closed' || pull.merged);
      items.sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, link } = paginate(ctx, path, query, items);
      return sendJson(ctx, res, 200, page.map((pull) => pullJson(ctx, repo, pull)), linkHeader(link));
    }
    if (method === 'POST') {
      if (!isRecord(body)) return err(ctx, res, 400, 'Invalid JSON');
      const title = asString(body.title);
      const head = asString(body.head);
      const base = asString(body.base);
      if (title === null || head === null || base === null) return err(ctx, res, 422, 'title, head and base are required');
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return err(ctx, res, 422, `head branch ${head} does not exist`);
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return err(ctx, res, 422, `base branch ${base} does not exist`);
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && !pull.merged && pull.head === head && pull.base === base);
      if (duplicate !== undefined) return err(ctx, res, 422, 'A pull request already exists for this head and base');
      const pull = store.createPull(repo, head, base, title, asString(body.body) ?? '');
      if (pull === null) return err(ctx, res, 422, 'could not create pull request');
      return sendJson(ctx, res, 201, pullJson(ctx, repo, pull));
    }
    return err(ctx, res, 405, 'Method Not Allowed');
  }
  const pullMatch = /^\/pulls\/(\d+)(\/(files|merge))?$/.exec(rest);
  if (pullMatch !== null) {
    const number = Number(pullMatch[1]);
    const pull = store.findPull(repo, number);
    if (pull === undefined) return err(ctx, res, 404, 'Not Found');
    const sub = pullMatch[3];
    if (sub === 'files') {
      if (method !== 'GET') return err(ctx, res, 405, 'Method Not Allowed');
      const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
      const base = store.mergeBase(repo, headTip, baseTip);
      const baseTree = base === null ? null : store.commitTree(repo, base);
      const headTree = store.commitTree(repo, headTip);
      const files = store.diffTrees(repo, baseTree, headTree);
      return sendJson(ctx, res, 200, files.map((file) => ({
        filename: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      })));
    }
    if (sub === 'merge') {
      if (method !== 'PUT') return err(ctx, res, 405, 'Method Not Allowed');
      if (pull.merged) return err(ctx, res, 405, 'Pull request is already merged');
      if (pull.state === 'closed') return err(ctx, res, 405, 'Pull request is closed');
      const plan = store.mergePlan(repo, pull);
      if (plan.conflict) return err(ctx, res, 405, 'Merge conflict');
      const mergeOid = store.doMerge(repo, pull);
      if (mergeOid === null) return err(ctx, res, 405, 'Merge conflict');
      pull.merged = true;
      pull.mergedAt = FIXED_ISO;
      pull.mergeSha = mergeOid;
      pull.state = 'closed';
      return sendJson(ctx, res, 200, { sha: mergeOid, merged: true, message: `Pull request successfully merged` });
    }
    if (method === 'GET') return sendJson(ctx, res, 200, pullJson(ctx, repo, pull));
    return err(ctx, res, 405, 'Method Not Allowed');
  }

  return err(ctx, res, 404, 'Not Found');
}

function commentJson(ctx: RestContext, repo: Repo, issue: Issue | Pull, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: ctx.store.commentGlobalId(comment),
    body: comment.body,
    user: ownerJson(ctx.viewerLogin),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') out.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') out.push(entry.name);
  }
  return out;
}

function handleContents(
  ctx: RestContext,
  _req: IncomingMessage,
  res: ServerResponse,
  method: string,
  repo: Repo,
  contentPath: string,
  query: URLSearchParams,
  body: unknown,
): void {
  const store = ctx.store;
  const refParam = query.get('ref');
  if (method === 'GET') {
    const tip = refParam === null ? store.defaultTip(repo) : store.resolveRef(repo, refParam);
    if (tip === null) return err(ctx, res, 404, 'Not Found');
    const read = store.contentsRead(repo, tip, contentPath);
    if (read === null) return err(ctx, res, 404, 'Not Found');
    if (read.kind === 'file') {
      const blob = repo.objects.get(read.blobOid);
      const content = blob === undefined ? '' : blob.data.toString('base64');
      const name = contentPath.split('/').pop() ?? '';
      return sendJson(ctx, res, 200, {
        type: 'file',
        encoding: 'base64',
        size: read.size,
        name,
        path: contentPath,
        content,
        sha: read.blobOid,
      });
    }
    return sendJson(ctx, res, 200, read.entries.map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: contentPath === '' ? entry.name : `${contentPath}/${entry.name}`,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    })));
  }
  if (method === 'PUT') {
    if (!isRecord(body)) return err(ctx, res, 400, 'Invalid JSON');
    const message = asString(body.message);
    const content = asString(body.content);
    if (message === null || content === null) return err(ctx, res, 422, 'message and content are required');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(content, 'base64');
    } catch {
      return err(ctx, res, 422, 'content is not valid base64');
    }
    const branch = asString(body.branch) ?? repo.defaultBranch;
    const sha = asString(body.sha);
    const result = store.contentsWrite(repo, branch, contentPath, bytes, message, sha ?? undefined);
    if ('error' in result) {
      if (result.error === 'conflict') return err(ctx, res, 409, 'sha does not match the current file');
      return err(ctx, res, 404, 'Not Found');
    }
    const existed = sha !== null;
    return sendJson(ctx, res, existed ? 200 : 201, {
      content: { name: contentPath.split('/').pop() ?? '', path: contentPath, sha: result.blobOid, size: bytes.length, type: 'file', encoding: 'base64' },
      commit: { sha: result.commitOid, message },
    });
  }
  if (method === 'DELETE') {
    if (!isRecord(body)) return err(ctx, res, 400, 'Invalid JSON');
    const message = asString(body.message);
    const sha = asString(body.sha);
    if (message === null || sha === null) return err(ctx, res, 422, 'message and sha are required');
    const branch = asString(body.branch) ?? repo.defaultBranch;
    const result = store.contentsDelete(repo, branch, contentPath, message, sha);
    if ('error' in result) {
      if (result.error === 'conflict') return err(ctx, res, 409, 'sha does not match the current file');
      return err(ctx, res, 404, 'Not Found');
    }
    return sendJson(ctx, res, 200, { commit: { sha: result.commitOid, message } });
  }
  return err(ctx, res, 405, 'Method Not Allowed');
}
