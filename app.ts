// The forge's HTTP server: one process, one port (chosen by the kernel, never 8080).
// Routes: /healthz, git smart HTTP, REST v3, GraphQL, MCP. Everything else: JSON 404.
// A handler that throws never kills the process: the server stays healthy.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { viewerIdentity } from './scenario.ts';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePackRequest, handleUploadPack } from './git-http.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

const viewer = viewerIdentity();
const store = new Store(viewer.login);

function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': store.requestId(),
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Read the whole request body (up to the cap); null when it is past the cap. */
async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function tokenValid(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '') return true;
  return req.headers.authorization === `Bearer ${token}`;
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let pathname = '/';
  let query = new URLSearchParams();
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    pathname = url.pathname;
    query = url.searchParams;
  } catch {
    sendJson(res, 400, { message: 'bad request' });
    return;
  }

  // Liveness: the boot check GETs this twice.
  if (pathname === '/healthz') {
    if (method !== 'GET') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack.
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(pathname);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1] as string);
    const repoName = decodeURIComponent(gitMatch[2] as string);
    const suffix = gitMatch[3] as string;
    if (suffix.startsWith('/info/refs')) {
      if (method !== 'GET') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      const service = query.get('service') ?? '';
      handleInfoRefs(req, res, store, owner, repoName, service);
      return;
    }
    if (suffix === '/git-upload-pack' || suffix === '/git-receive-pack') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      const body = await readBody(req);
      if (body === null) {
        sendJson(res, 413, { message: 'body too large' });
        return;
      }
      if (suffix === '/git-upload-pack') handleUploadPack(req, res, store, owner, repoName, body);
      else handleReceivePackRequest(req, res, store, owner, repoName, body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GraphQL: POST /api/graphql, auth required, 401 exactly when unauthenticated.
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!tokenValid(req)) {
      sendJson(res, 401, { errors: [{ message: 'Unauthorized' }] });
      return;
    }
    const body = await readBody(req);
    if (body === null) {
      sendJson(res, 413, { message: 'body too large' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'request body is not valid JSON' }] });
      return;
    }
    handleGraphql({ store, viewerLogin: viewer.login }, req, res, parsed);
    return;
  }

  // MCP: POST /mcp (auth required), DELETE /mcp (session close, best-effort).
  if (pathname === '/mcp') {
    if (method === 'DELETE') {
      res.writeHead(405, { 'content-length': 0 });
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const body = await readBody(req);
    if (body === null) {
      sendJson(res, 413, { message: 'body too large' });
      return;
    }
    handleMcp({ store, viewerLogin: viewer.login }, req, res, body);
    return;
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const isPublic = pathname === '/api/v3' || pathname === '/api/v3/' || pathname === '/api/v3/meta';
    if (!isPublic && !tokenValid(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    let body: unknown = undefined;
    if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw === null) {
        sendJson(res, 413, { message: 'body too large' });
        return;
      }
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return;
        }
      }
    }
    handleRest({ store, baseUrl: baseUrlOf(req), viewerLogin: viewer.login }, req, res, method, pathname, query, body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

export function createApp(): Server {
  const server = createServer((req, res) => {
    void dispatch(req, res).catch((err: unknown) => {
      process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      try {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } catch {
        // The peer went away; nothing more to do.
      }
    });
  });
  return server;
}
