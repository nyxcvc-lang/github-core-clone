// Git smart HTTP: info/refs advertisements (v2/v0), ls-refs, fetch (v2), receive-pack.
// Follows the wire the suite's git client speaks (kit program/env/src/git-client.ts).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  decodePktLines,
  decodePktLinesUntilFlush,
  encodePktLine,
  encodePktLines,
  hashObject,
  isOid,
  parseTag,
  parseTree,
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObject,
  type PktLine,
} from './git.ts';
import type { Repo, Store } from './store.ts';

const AGENT = 'forge/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** Sorted ref list: branches then tags, each as [refname, oid, peeledCommitOid?]. */
function listRefs(repo: Repo): Array<{ ref: string; oid: string; peeled?: string }> {
  const out: Array<{ ref: string; oid: string; peeled?: string }> = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [ref, oid] of refs) {
    const entry: { ref: string; oid: string; peeled?: string } = { ref, oid };
    if (ref.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const commit = parseTag(object.data).object;
        const peeled = repo.objects.get(commit)?.type === 'commit' ? commit : undefined;
        if (peeled !== undefined) entry.peeled = peeled;
      }
    }
    out.push(entry);
  }
  return out;
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** v2 upload-pack advertisement. */
function v2Advertisement(repo: Repo): Buffer {
  const lines: (string | 'flush')[] = [
    `# service=git-upload-pack\n`,
    'flush',
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ];
  void repo;
  return encodePktLines(lines);
}

/** v0 advertisement for a service: `# service=...`, flush, ref lines, flush. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? 'side-band-64k symref=HEAD:refs/heads/main agent=forge/1.0 ofs-delta'
      : 'report-status side-band-64k delete-refs agent=forge/1.0 ofs-delta';
  const parts: Buffer[] = [];
  parts.push(encodePktLine(`# service=${service}\n`));
  parts.push(Buffer.from('0000', 'ascii'));
  const refs = listRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = headTip ?? refs[0]?.oid ?? ZERO_OID;
    parts.push(encodePktLine(`${headOid} HEAD\0${caps}\n`));
    for (const entry of refs) {
      parts.push(encodePktLine(`${entry.oid} ${entry.ref}\n`));
      if (entry.peeled !== undefined) parts.push(encodePktLine(`${entry.peeled} ${entry.ref}^{}\n`));
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  service: string,
): void {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(res, 400, { message: `unknown service ${service}` });
    return;
  }
  const protocol = req.headers['git-protocol'];
  if (service === 'git-upload-pack' && protocol === 'version=2') {
    sendBuffer(res, 200, UPLOAD_AD, v2Advertisement(repo));
    return;
  }
  const contentType = service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD;
  sendBuffer(res, 200, contentType, v0Advertisement(repo, service));
}

// ---------------------------------------------------------------- ls-refs / fetch (v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(packets: PktLine[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, prefixes: [] };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (line === 'command=ls-refs\n') continue;
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    if (!seenDelim) continue;
    if (line === 'peel\n') args.peel = true;
    else if (line === 'symrefs\n') args.symrefs = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length).replace(/\n$/, ''));
  }
  return args;
}

function handleLsRefs(repo: Repo, packets: PktLine[]): Buffer {
  const args = parseLsRefsArgs(packets);
  const lines: string[] = [];
  const refs = listRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const includeHead = headTip !== undefined && (args.prefixes.length === 0 || args.prefixes.some((prefix) => 'HEAD'.startsWith(prefix)));
  if (includeHead && headTip !== undefined) {
    const symref = args.symrefs ? ' symref-target:refs/heads/main' : '';
    lines.push(`${headTip} HEAD${symref}\n`);
  }
  for (const entry of refs) {
    if (args.prefixes.length > 0 && !args.prefixes.some((prefix) => entry.ref.startsWith(prefix))) continue;
    const peeled = args.peel && entry.peeled !== undefined ? ` peeled:${entry.peeled}` : '';
    lines.push(`${entry.oid} ${entry.ref}${peeled}\n`);
  }
  const parts: Buffer[] = [];
  for (const line of lines) parts.push(encodePktLine(line));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(packets: PktLine[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (line === 'command=fetch\n') continue;
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    if (!seenDelim) continue;
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(depth) && depth > 0) args.depth = depth;
    }
    // thin-pack, no-progress, ofs-delta, done, filter, deepen-since, deepen-not: accepted, ignored.
  }
  return args;
}

/**
 * The objects a fetch returns: commits within depth D of the wants (D=1: wants only;
 * no depth: the whole reachable history) plus their full tree closures, minus everything
 * reachable from the haves. Also the new shallow boundaries and the unshallowed old ones.
 */
function computeFetch(
  store: Store,
  repo: Repo,
  args: FetchArgs,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const wants = [...new Set(args.wants)].filter((oid) => isOid(oid) && repo.objects.get(oid)?.type === 'commit');
  const haves = [...new Set(args.haves)].filter((oid) => isOid(oid) && repo.objects.get(oid)?.type === 'commit');
  const shallowSet = new Set(args.shallow);
  // What the client already holds: the full history closure of the haves, except a shallow
  // boundary's ancestors are NOT held (a shallow clone holds the boundary, not its history).
  const held = new Set<string>();
  for (const have of haves) {
    const stack = [have];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      for (const objectOid of store.commitClosure(repo, oid)) held.add(objectOid);
      if (shallowSet.has(oid)) continue;
      for (const parent of store.commitParents(repo, oid)) stack.push(parent);
    }
  }
  // BFS from the wants, tracking distance; include commits at distance < D (D=1: wants only).
  const depth = args.depth;
  const included = new Map<string, number>();
  const queue: Array<[string, number]> = wants.map((oid) => [oid, 0] as [string, number]);
  while (queue.length > 0) {
    const [oid, dist] = queue.shift() as [string, number];
    if (included.has(oid)) continue;
    if (depth !== null && dist >= depth) continue;
    included.set(oid, dist);
    for (const parent of store.commitParents(repo, oid)) queue.push([parent, dist + 1]);
  }
  const result = new Set<string>();
  for (const oid of included.keys()) {
    for (const objectOid of store.commitClosure(repo, oid)) {
      if (!held.has(objectOid)) result.add(objectOid);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of result) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  // New shallow boundaries: the deepest included layer (distance D-1), with a parent.
  let shallow: string[] = [];
  if (depth !== null) {
    for (const [oid, dist] of included) {
      if (dist === depth - 1 && store.commitParents(repo, oid).length > 0) shallow.push(oid);
    }
  }
  // Unshallow: old boundaries whose parents are now all available (held or included).
  const available = new Set<string>([...held, ...included.keys()]);
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const old of args.shallow) {
      const parents = store.commitParents(repo, old);
      if (parents.length > 0 && parents.every((parent) => available.has(parent))) unshallow.push(old);
    }
  } else {
    for (const old of args.shallow) {
      const parents = store.commitParents(repo, old);
      if (parents.length > 0 && parents.every((parent) => available.has(parent) || store.reachableCommits(repo, wants).has(parent))) {
        unshallow.push(old);
      }
    }
  }
  shallow = [...new Set(shallow)];
  return { objects, shallow, unshallow: [...new Set(unshallow)] };
}

/** One sideband pkt-line: band byte + up to 65515 payload bytes. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 65515) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65515));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    out.push(encodePktLine(payload));
  }
  return out;
}

function handleFetch(store: Store, repo: Repo, packets: PktLine[]): Buffer {
  const args = parseFetchArgs(packets);
  const { objects, shallow, unshallow } = computeFetch(store, repo, args);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  parts.push(encodePktLine('NAK\n'));
  parts.push(Buffer.from('0001', 'ascii'));
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  parts.push(encodePktLine('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack — ls-refs or fetch (v2). */
export function handleUploadPack(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, repoName: string, body: Buffer): void {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  let packets: PktLine[];
  try {
    packets = decodePktLines(body);
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line stream' });
    return;
  }
  const first = packets.find((packet) => packet.kind === 'data')?.payload.toString('utf8') ?? '';
  if (first.startsWith('command=ls-refs')) {
    sendBuffer(res, 200, UPLOAD_RESULT, handleLsRefs(repo, packets));
    return;
  }
  if (first.startsWith('command=fetch')) {
    void req;
    sendBuffer(res, 200, UPLOAD_RESULT, handleFetch(store, repo, packets));
    return;
  }
  sendJson(res, 400, { message: 'unknown upload-pack command' });
}

// ---------------------------------------------------------------- receive-pack (push)

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  // Parse command pkt-lines up to the flush; the rest is the pack.
  let packets: PktLine[];
  let packBytes: Buffer;
  try {
    const parsed = decodePktLinesUntilFlush(body);
    packets = parsed.packets;
    packBytes = body.subarray(parsed.restOffset);
  } catch {
    throw new Error('malformed pkt-line stream');
  }
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error('malformed push command');
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid)) throw new Error('malformed push command oid');
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new Error('push with no commands');

  // Unpack first (objects are stored even when a ref is refused), then judge each ref.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const checksum = verifyPackChecksum(packBytes);
      if (!checksum.ok) throw new Error('pack checksum mismatch');
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      store.putObjects(repo, read.objects.values());
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const reportLines: string[] = [`unpack ${unpackDetail}\n`];
  for (const command of commands) {
    let ok = false;
    if (unpackOk) {
      const current = repo.refs.get(command.ref);
      if (!command.ref.startsWith('refs/')) {
        ok = false;
      } else if (command.newOid === ZERO_OID) {
        // Delete: old must match the current tip.
        if (current !== undefined && current === command.oldOid) {
          repo.refs.delete(command.ref);
          ok = true;
        }
      } else if (command.oldOid === ZERO_OID) {
        // Create: the ref must not exist, and the new object must be a commit we hold.
        const object = repo.objects.get(command.newOid);
        if (current === undefined && object !== undefined && object.type === 'commit') {
          repo.refs.set(command.ref, command.newOid);
          ok = true;
        }
      } else {
        // Update: old must be the current tip and new must descend from old.
        const object = repo.objects.get(command.newOid);
        if (current !== undefined && current === command.oldOid && object !== undefined && object.type === 'commit') {
          if (command.newOid === command.oldOid) ok = true;
          else {
            const reachable = store.reachableCommits(repo, [command.newOid]);
            if (reachable.has(command.oldOid)) {
              repo.refs.set(command.ref, command.newOid);
              ok = true;
            }
          }
        }
      }
    }
    reportLines.push(ok ? `ok ${command.ref}\n` : `ng ${command.ref} non-fast-forward\n`);
  }
  const inner = encodePktLines([...reportLines, 'flush']);
  // The report-status stream rides inside sideband band 1 (side-band-64k was negotiated).
  const parts: Buffer[] = [];
  for (let offset = 0; offset < inner.length; offset += 65515) {
    const chunk = inner.subarray(offset, Math.min(inner.length, offset + 65515));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePackRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
): void {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  try {
    const result = handleReceivePack(store, repo, body);
    sendBuffer(res, 200, RECEIVE_RESULT, result);
  } catch {
    sendJson(res, 400, { message: 'malformed push' });
  }
}
