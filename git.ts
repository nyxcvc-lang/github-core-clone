// Git object model, packfiles and pkt-lines. Node stdlib only (crypto, zlib).
// No git binary, no dependencies. All hashes are SHA-1, the suite's object format.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Git's tree-entry order: names compared bytewise, directories as `name/`. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
}): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- pkt-lines

export type PktLine = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/** One pkt-line framing `payload` (payload length must fit: total ≤ 65520). */
export function encodePktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const total = body.length + 4;
  if (total > 65520) throw new Error('pkt-line payload too large');
  const header = Buffer.from(total.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export function encodePktLines(lines: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(Buffer.from('0000', 'ascii'));
    else if (line === 'delim') parts.push(Buffer.from('0001', 'ascii'));
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

/** Decode every pkt-line in `buf`; throws on malformed framing. */
export function decodePktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (hex === '0000') {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (hex === '0001') {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = Number.parseInt(hex, 16);
    if (length < 4 || offset + length > buf.length) throw new Error('bad pkt-line length');
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return out;
}

/**
 * Parse pkt-lines from the start of `buf` until the first flush (or end of buffer).
 * Returns the packets and the offset where the bytes after the flush begin (a pack body).
 * Throws on malformed framing.
 */
export function decodePktLinesUntilFlush(buf: Buffer): { packets: PktLine[]; restOffset: number } {
  const packets: PktLine[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (hex === '0000') {
      packets.push({ kind: 'flush' });
      return { packets, restOffset: offset + 4 };
    }
    if (hex === '0001') {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = Number.parseInt(hex, 16);
    if (length < 4 || offset + length > buf.length) throw new Error('bad pkt-line length');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, restOffset: offset };
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/**
 * Inflate the zlib stream starting at `offset`, whose inflated size is `expectedSize`.
 *
 * v2: one inflate instead of ~nine. `inflateSync` stops at the end of the first zlib
 * stream and ignores trailing bytes, so a single inflate of the remainder yields the
 * object (verified: on a 3-object pack the remainder inflate returns exactly the
 * first object's bytes). The stream's true end is its closing Adler-32 checksum:
 * the 4 bytes after the deflate data equal adler32(data), so the first candidate end
 * is found by searching for those bytes, and verified by inflating the candidate
 * slice — a false Adler match inside the deflate data fails the slice inflate and
 * the search moves on. If no candidate verifies (never seen on a valid pack), fall
 * back to the legacy binary search below.
 */
function inflateAt(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; nextOffset: number } {
  const data = inflateSync(buf.subarray(offset));
  if (data.length !== expectedSize) throw new Error('inflated size mismatch');
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler32(data), 0);
  let candidate = buf.indexOf(needle, offset);
  while (candidate >= 0) {
    const end = candidate + 4;
    try {
      const probe = inflateSync(buf.subarray(offset, end));
      if (probe.length === expectedSize) return { data, nextOffset: end };
    } catch {
      // Not the true stream end (Adler bytes coinciding inside the deflate data).
    }
    candidate = buf.indexOf(needle, end);
  }
  return inflateAtLegacy(buf, offset, expectedSize);
}

/** Adler-32, the checksum that closes every zlib stream (mod 65521). */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Legacy inflateAt: binary search for the smallest end that inflates to the expected
 * size (~9 inflates per object). Kept as the fallback when the Adler search finds no
 * verifiable stream end, and as the reference implementation for the unit tests.
 */
function inflateAtLegacy(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; nextOffset: number } {
  let guess = Math.min(buf.length - offset, Math.max(64, expectedSize + 32));
  for (;;) {
    const end = Math.min(buf.length, offset + guess);
    try {
      const data = inflateSync(buf.subarray(offset, end));
      if (data.length !== expectedSize) throw new Error('inflated size mismatch');
      // The stream may end before `end` (trailing bytes ignored); find its true end by
      // shrinking: the smallest end that still inflates to the expected size.
      let lo = offset + 1;
      let hi = end;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        try {
          const probe = inflateSync(buf.subarray(offset, mid));
          if (probe.length === expectedSize) hi = mid;
          else lo = mid + 1;
        } catch {
          lo = mid + 1;
        }
      }
      return { data, nextOffset: hi };
    } catch (err) {
      if (end >= buf.length) throw err;
      guess *= 2;
    }
  }
}

function readVarint(buf: Buffer, offset: number): { value: number; nextOffset: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated varint');
    const byte = buf[pos] as number;
    pos += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, nextOffset: pos };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const sourceSize = readVarint(delta, pos);
  pos = sourceSize.nextOffset;
  if (sourceSize.value !== base.length) throw new Error('delta source size mismatch');
  const targetSize = readVarint(delta, pos);
  pos = targetSize.nextOffset;
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) { offset = delta[pos] as number; pos += 1; }
      if ((op & 0x02) !== 0) { offset |= (delta[pos] as number) << 8; pos += 1; }
      if ((op & 0x04) !== 0) { offset |= (delta[pos] as number) << 16; pos += 1; }
      if ((op & 0x08) !== 0) { offset |= (delta[pos] as number) << 24; pos += 1; }
      if ((op & 0x10) !== 0) { size = delta[pos] as number; pos += 1; }
      if ((op & 0x20) !== 0) { size |= (delta[pos] as number) << 8; pos += 1; }
      if ((op & 0x40) !== 0) { size |= (delta[pos] as number) << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new Error('delta insert out of range');
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (produced !== targetSize.value) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

interface PackEntry {
  headerStart: number;
  typeId: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Read one object header at `offset`: type id, inflated size, offset past the header. */
function readObjectHeader(pack: Buffer, offset: number): { typeId: number; size: number; nextOffset: number } {
  if (offset >= pack.length) throw new Error('pack truncated');
  const first = pack[offset] as number;
  let pos = offset + 1;
  const typeId = (first >> 4) & 0x7;
  let size = first & 0x0f;
  let shift = 4;
  let cont = (first & 0x80) !== 0;
  while (cont) {
    if (pos >= pack.length) throw new Error('pack truncated');
    const byte = pack[pos] as number;
    pos += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    cont = (byte & 0x80) !== 0;
  }
  return { typeId, size, nextOffset: pos };
}

/**
 * Read a packfile (version 2), resolving OFS_DELTA/REF_DELTA. `resolveBase` answers bases that
 * live outside the pack (the store); without it a REF_DELTA to an outside object fails.
 * Two passes: read every entry first (plain objects hashed at once), then resolve deltas in
 * pack order, so a delta may base on an earlier delta (a chain) or a later plain object.
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): ReadPackResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const entries: PackEntry[] = [];
  const oidByHeaderStart = new Map<number, string>();
  let offset = 12;
  let deltaCount = 0;
  for (let index = 0; index < count; index += 1) {
    const headerStart = offset;
    const header = readObjectHeader(pack, offset);
    offset = header.nextOffset;
    const { typeId, size } = header;
    if (typeId === 6) {
      // OFS_DELTA: negative offset varint (each byte contributes 7 bits, +1 per byte but the first).
      if (offset >= pack.length) throw new Error('pack truncated');
      let byte = pack[offset] as number;
      offset += 1;
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (offset >= pack.length) throw new Error('pack truncated');
        byte = pack[offset] as number;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const inflated = inflateAt(pack, offset, size);
      offset = inflated.nextOffset;
      entries.push({ headerStart, typeId, size, data: inflated.data, baseOffset });
      deltaCount += 1;
      continue;
    }
    if (typeId === 7) {
      if (offset + 20 > pack.length) throw new Error('pack truncated');
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset, size);
      offset = inflated.nextOffset;
      entries.push({ headerStart, typeId, size, data: inflated.data, baseOid });
      deltaCount += 1;
      continue;
    }
    const type = PACK_TYPES[typeId];
    if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
    const inflated = inflateAt(pack, offset, size);
    offset = inflated.nextOffset;
    const oid = hashObject(type, inflated.data);
    if (!objects.has(oid)) objects.set(oid, { type, data: inflated.data });
    oidByHeaderStart.set(headerStart, oid);
  }
  for (const entry of entries) {
    if (entry.typeId !== 6 && entry.typeId !== 7) continue;
    let base: GitObject | undefined;
    if (entry.baseOffset !== undefined) {
      const baseStart = entry.headerStart - entry.baseOffset;
      const baseOid = oidByHeaderStart.get(baseStart);
      if (baseOid === undefined) throw new Error(`delta base at offset ${baseStart} not resolved`);
      base = objects.get(baseOid);
    } else if (entry.baseOid !== undefined) {
      base = objects.get(entry.baseOid) ?? resolveBase?.(entry.baseOid);
    }
    if (base === undefined) throw new Error('delta base not found');
    const data = applyDelta(base.data, entry.data);
    const oid = hashObject(base.type, data);
    if (!objects.has(oid)) objects.set(oid, { type: base.type, data });
    oidByHeaderStart.set(entry.headerStart, oid);
  }
  return { objects, deltaCount };
}

/** Build a packfile from plain objects (no deltas), in the caller's order. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  const body = Buffer.concat(parts);
  const chunks: Buffer[] = [body];
  for (const object of objects) {
    const typeId = PACK_TYPE_IDS[object.type];
    const size = object.data.length;
    const headerBytes: number[] = [];
    let remaining = size;
    headerBytes.push(((typeId << 4) | (remaining & 0x0f)) | (remaining > 0x0f ? 0x80 : 0));
    remaining >>>= 4;
    while (remaining > 0) {
      headerBytes.push((remaining & 0x7f) | (remaining > 0x7f ? 0x80 : 0));
      remaining >>>= 7;
    }
    chunks.push(Buffer.from(headerBytes));
    chunks.push(deflateSync(object.data));
  }
  const withoutTrailer = Buffer.concat(chunks);
  const trailer = Buffer.from(sha1Hex(withoutTrailer), 'hex');
  return Buffer.concat([withoutTrailer, trailer]);
}

/** Verify a packfile's SHA-1 trailer. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; actual: string; expected: string } {
  if (pack.length < 20) return { ok: false, actual: '', expected: '' };
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = sha1Hex(pack.subarray(0, pack.length - 20));
  return { ok: actual === expected, actual, expected };
}
