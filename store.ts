// The forge's in-memory store: repositories, git objects, refs, issues, pull requests.
// Everything is deterministic: fixed timestamps, sequential ids, no clock, no randomness.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

export const FIXED_ISO = '2025-01-01T00:00:00Z';
export const FIXED_EPOCH_SEC = 1735689600;

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
  user: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: Comment[];
  user: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
  comments: Comment[];
  user: string;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
}

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  oldOid: string | null;
  newOid: string | null;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (const byte of data) if (byte === 0x0a) count += 1;
  if (data[data.length - 1] !== 0x0a) count += 1;
  return count;
}

export class Store {
  readonly viewerLogin: string;
  readonly viewerId = 1000;
  repos = new Map<string, Repo>();
  repoById = new Map<number, Repo>();
  nextRepoId = 1;
  nextItemId = 1;
  nextReqId = 1;
  nextSeq = 1;

  constructor(viewerLogin: string) {
    this.viewerLogin = viewerLogin;
  }

  requestId(): string {
    const id = this.nextReqId;
    this.nextReqId += 1;
    return `req-${String(id).padStart(8, '0')}`;
  }

  identityLine(): string {
    return `${this.viewerLogin} <${this.viewerLogin}@example.invalid> ${FIXED_EPOCH_SEC} +0000`;
  }

  // ------------------------------------------------------------ repos

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(`${this.viewerLogin}/${name}`)) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: this.viewerLogin,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: this.nextSeq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
    };
    this.nextRepoId += 1;
    this.nextSeq += 1;
    this.repos.set(`${this.viewerLogin}/${name}`, repo);
    this.repoById.set(repo.id, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(`${owner}/${name}`);
    if (repo === undefined) return false;
    this.repos.delete(`${owner}/${name}`);
    this.repoById.delete(repo.id);
    return true;
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ------------------------------------------------------------ objects and refs

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  putObjects(repo: Repo, objects: Iterable<GitObject>): void {
    for (const object of objects) {
      const oid = hashObject(object.type, object.data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Resolve a branch name, a full ref, or an oid to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref.startsWith('refs/')) {
      const oid = repo.refs.get(ref);
      return oid ?? null;
    }
    const branchOid = repo.refs.get(`refs/heads/${ref}`);
    if (branchOid !== undefined) return branchOid;
    if (isOid(ref)) {
      const object = repo.objects.get(ref);
      if (object !== undefined && object.type === 'commit') return ref;
      if (object !== undefined && object.type === 'tag') {
        const tag = parseTag(object.data);
        return this.resolveRef(repo, tag.object);
      }
    }
    return null;
  }

  /** The commit a tag points at (peeling annotated tags), or null. */
  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let depth = 0; depth < 10; depth += 1) {
      const object = repo.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** Default-branch tip, or null for an unborn repo. */
  defaultTip(repo: Repo): string | null {
    const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    return oid ?? null;
  }

  commitParents(repo: Repo, commitOid: string): string[] {
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return [];
    return parseCommit(object.data).parents;
  }

  commitTree(repo: Repo, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** All commits reachable from `starts` (parents walked), in first-seen order. */
  reachableCommits(repo: Repo, starts: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...starts];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return seen;
  }

  /** Add a tree's whole closure (subtrees + blobs) to `out`. */
  treeClosure(repo: Repo, treeOid: string, out: Set<string>): void {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') continue;
      out.add(oid);
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '40000') stack.push(entry.oid);
        else out.add(entry.oid);
      }
    }
  }

  /** The full object closure of a commit: the commit, its tree closure. */
  commitClosure(repo: Repo, commitOid: string): Set<string> {
    const out = new Set<string>();
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return out;
    out.add(commitOid);
    this.treeClosure(repo, parseCommit(object.data).tree, out);
    return out;
  }

  /** Flatten a commit's tree to path -> entry. */
  flattenTree(repo: Repo, treeOid: string): Map<string, TreeEntry> {
    const out = new Map<string, TreeEntry>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, entry);
      }
    };
    walk(treeOid, '');
    return out;
  }

  /**
   * A tree like `baseTreeOid` but with `segments` set to `blobOid` (or removed when null).
   * Intermediate trees are created or pruned as needed; returns the new tree oid.
   */
  treeWithPath(repo: Repo, baseTreeOid: string | null, segments: readonly string[], blobOid: string | null): string {
    const head = segments[0] as string;
    const rest = segments.slice(1);
    let entries: TreeEntry[] = [];
    if (baseTreeOid !== null) {
      const object = repo.objects.get(baseTreeOid);
      if (object !== undefined && object.type === 'tree') entries = parseTree(object.data);
    }
    const kept = entries.filter((entry) => entry.name !== head);
    if (rest.length === 0) {
      if (blobOid !== null) kept.push({ mode: '100644', name: head, oid: blobOid });
    } else {
      const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
      const childOid = existing === undefined ? null : existing.oid;
      const next = this.treeWithPath(repo, childOid, rest, blobOid);
      // Prune: only keep the subtree when it still holds entries.
      const child = repo.objects.get(next);
      const childEntries = child !== undefined && child.type === 'tree' ? parseTree(child.data) : [];
      if (childEntries.length > 0) kept.push({ mode: '40000', name: head, oid: next });
    }
    const data = buildTree(kept);
    return this.putObject(repo, 'tree', data);
  }

  /** The merge base of two commits: the common ancestor nearest both (BFS from each side). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const distA = new Map<string, number>();
    const queueA: Array<[string, number]> = [[a, 0]];
    while (queueA.length > 0) {
      const [oid, dist] = queueA.shift() as [string, number];
      if (distA.has(oid)) continue;
      distA.set(oid, dist);
      for (const parent of this.commitParents(repo, oid)) queueA.push([parent, dist + 1]);
    }
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    const queueB: Array<[string, number]> = [[b, 0]];
    const seenB = new Set<string>();
    while (queueB.length > 0) {
      const [oid, dist] = queueB.shift() as [string, number];
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const da = distA.get(oid);
      if (da !== undefined) {
        const score = da + dist;
        if (score < bestScore) {
          bestScore = score;
          best = oid;
        }
      }
      for (const parent of this.commitParents(repo, oid)) queueB.push([parent, dist + 1]);
    }
    return best;
  }

  /** Diff two trees: files added/modified/removed between base and head. */
  diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): DiffFile[] {
    const base = baseTreeOid === null ? new Map<string, TreeEntry>() : this.flattenTree(repo, baseTreeOid);
    const head = headTreeOid === null ? new Map<string, TreeEntry>() : this.flattenTree(repo, headTreeOid);
    const files: DiffFile[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const oldEntry = base.get(path);
      const newEntry = head.get(path);
      if (oldEntry === undefined && newEntry !== undefined) {
        const blob = repo.objects.get(newEntry.oid);
        const additions = blob === undefined ? 0 : lineCount(blob.data);
        files.push({ path, status: 'added', additions, deletions: 0, changes: additions, oldOid: null, newOid: newEntry.oid });
      } else if (oldEntry !== undefined && newEntry === undefined) {
        const blob = repo.objects.get(oldEntry.oid);
        const deletions = blob === undefined ? 0 : lineCount(blob.data);
        files.push({ path, status: 'removed', additions: 0, deletions, changes: deletions, oldOid: oldEntry.oid, newOid: null });
      } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
        const oldBlob = repo.objects.get(oldEntry.oid);
        const newBlob = repo.objects.get(newEntry.oid);
        const additions = newBlob === undefined ? 0 : lineCount(newBlob.data);
        const deletions = oldBlob === undefined ? 0 : lineCount(oldBlob.data);
        files.push({ path, status: 'modified', additions, deletions, changes: additions + deletions, oldOid: oldEntry.oid, newOid: newEntry.oid });
      }
    }
    return files;
  }

  /** Whether a pull request merges cleanly (file-level three-way merge), and its merged tree. */
  mergePlan(repo: Repo, pull: Pull): { conflict: boolean; mergedFiles: Map<string, string | null> } {
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    const mergedFiles = new Map<string, string | null>();
    if (headTip === undefined || baseTip === undefined) return { conflict: true, mergedFiles };
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseTree = base === null ? null : this.commitTree(repo, base);
    const headTree = this.commitTree(repo, headTip);
    const baseTipTree = this.commitTree(repo, baseTip);
    const baseFiles = baseTree === null ? new Map<string, TreeEntry>() : this.flattenTree(repo, baseTree);
    const headFiles = headTree === null ? new Map<string, TreeEntry>() : this.flattenTree(repo, headTree);
    const tipFiles = baseTipTree === null ? new Map<string, TreeEntry>() : this.flattenTree(repo, baseTipTree);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
    let conflict = false;
    for (const path of paths) {
      const atBase = baseFiles.get(path)?.oid ?? null;
      const atHead = headFiles.get(path)?.oid ?? null;
      const atTip = tipFiles.get(path)?.oid ?? null;
      if (atHead === atBase) {
        mergedFiles.set(path, atTip);
      } else if (atTip === atBase) {
        mergedFiles.set(path, atHead);
      } else if (atHead === atTip) {
        mergedFiles.set(path, atHead);
      } else {
        conflict = true;
      }
    }
    return { conflict, mergedFiles };
  }

  /** Squash-merge a pull request: one commit on the base branch. Returns the merge oid or null. */
  doMerge(repo: Repo, pull: Pull): string | null {
    const plan = this.mergePlan(repo, pull);
    if (plan.conflict) return null;
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (baseTip === undefined) return null;
    // Build the merged tree from the base tip's tree, applying the merged file set.
    const baseTree = this.commitTree(repo, baseTip);
    let treeOid = baseTree ?? this.putObject(repo, 'tree', buildTree([]));
    const allPaths = new Set<string>();
    if (baseTree !== null) {
      for (const path of this.flattenTree(repo, baseTree).keys()) allPaths.add(path);
    }
    for (const path of plan.mergedFiles.keys()) allPaths.add(path);
    // Apply removals and updates path by path (sorted parents-first so trees nest correctly).
    const sorted = [...allPaths].sort();
    const wanted = new Map<string, string>();
    for (const path of sorted) {
      const oid = plan.mergedFiles.get(path);
      if (oid !== undefined && oid !== null) wanted.set(path, oid);
    }
    // Rebuild the tree from scratch: group files by directory.
    treeOid = this.buildTreeFromFiles(repo, wanted);
    const commit = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message: `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`,
      author: this.identityLine(),
      committer: this.identityLine(),
    });
    const mergeOid = this.putObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${pull.base}`, mergeOid);
    return mergeOid;
  }

  /** Build a tree object from a flat path -> blob oid map (nested dirs created as needed). */
  buildTreeFromFiles(repo: Repo, files: Map<string, string>): string {
    const buildLevel = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, oid] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) entries.push({ mode: '100644', name: rest, oid });
        else dirs.add(rest.slice(0, slash));
      }
      for (const dir of dirs) {
        const sub = buildLevel(`${prefix}${dir}/`);
        entries.push({ mode: '40000', name: dir, oid: sub });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return buildLevel('');
  }

  // ------------------------------------------------------------ labels

  createLabel(repo: Repo, name: string, color: string, description = ''): Label | null {
    if (repo.labels.has(name)) return null;
    const label: Label = { name, color, description };
    repo.labels.set(name, label);
    return label;
  }

  // ------------------------------------------------------------ issues and pulls

  private nextNumber(repo: Repo): number {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    return number;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      id: this.nextItemId,
      number: this.nextNumber(repo),
      title,
      body,
      state: 'open',
      labels,
      createdSeq: this.nextSeq,
      comments: [],
      user: this.viewerLogin,
    };
    this.nextItemId += 1;
    this.nextSeq += 1;
    repo.issues.push(issue);
    return issue;
  }

  findIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  findPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  findItem(repo: Repo, number: number): Issue | Pull | undefined {
    return this.findIssue(repo, number) ?? this.findPull(repo, number);
  }

  createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull | null {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return null;
    const pull: Pull = {
      id: this.nextItemId,
      number: this.nextNumber(repo),
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeSha: null,
      head,
      base,
      headSha,
      baseSha,
      createdSeq: this.nextSeq,
      comments: [],
      user: this.viewerLogin,
    };
    this.nextItemId += 1;
    this.nextSeq += 1;
    repo.pulls.push(pull);
    return pull;
  }

  addComment(item: Issue | Pull, body: string): Comment {
    const comment: Comment = { id: this.nextItemId, body, createdSeq: this.nextSeq, user: this.viewerLogin };
    this.nextItemId += 1;
    this.nextSeq += 1;
    item.comments.push(comment);
    return comment;
  }

  // ------------------------------------------------------------ contents

  /** Create or update a file on a branch; returns the commit oid and blob oid. */
  contentsWrite(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    expectedSha?: string,
  ): { commitOid: string; blobOid: string } | { error: 'conflict' | 'no-branch' | 'not-found' } {
    const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
    if (segments.length === 0) return { error: 'not-found' };
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) {
      // Unborn branch: only the default branch may be born this way, and only on an empty repo.
      if (repo.refs.size > 0) return { error: 'no-branch' };
      const blobOid = this.putObject(repo, 'blob', content);
      const treeOid = this.treeWithPath(repo, null, segments, blobOid);
      const commit = buildCommit({
        tree: treeOid,
        parents: [],
        message: `${message}\n`,
        author: this.identityLine(),
        committer: this.identityLine(),
      });
      const commitOid = this.putObject(repo, 'commit', commit);
      repo.refs.set(ref, commitOid);
      return { commitOid, blobOid };
    }
    const tree = this.commitTree(repo, tip);
    const files = tree === null ? new Map<string, TreeEntry>() : this.flattenTree(repo, tree);
    const existing = files.get(segments.join('/'));
    if (expectedSha !== undefined) {
      if (existing === undefined) return { error: 'conflict' };
      if (existing.oid !== expectedSha) return { error: 'conflict' };
    }
    const isCreate = existing === undefined;
    void isCreate;
    const blobOid = this.putObject(repo, 'blob', content);
    const treeOid = this.treeWithPath(repo, tree, segments, blobOid);
    const commit = buildCommit({
      tree: treeOid,
      parents: [tip],
      message: `${message}\n`,
      author: this.identityLine(),
      committer: this.identityLine(),
    });
    const commitOid = this.putObject(repo, 'commit', commit);
    repo.refs.set(ref, commitOid);
    return { commitOid, blobOid };
  }

  /** Delete a file on a branch; returns the commit oid. */
  contentsDelete(
    repo: Repo,
    branch: string,
    path: string,
    message: string,
    expectedSha: string,
  ): { commitOid: string } | { error: 'conflict' | 'no-branch' | 'not-found' } {
    const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
    if (segments.length === 0) return { error: 'not-found' };
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return { error: 'no-branch' };
    const tree = this.commitTree(repo, tip);
    const files = tree === null ? new Map<string, TreeEntry>() : this.flattenTree(repo, tree);
    const existing = files.get(segments.join('/'));
    if (existing === undefined) return { error: 'not-found' };
    if (existing.oid !== expectedSha) return { error: 'conflict' };
    const treeOid = this.treeWithPath(repo, tree, segments, null);
    const commit = buildCommit({
      tree: treeOid,
      parents: [tip],
      message: `${message}\n`,
      author: this.identityLine(),
      committer: this.identityLine(),
    });
    const commitOid = this.putObject(repo, 'commit', commit);
    repo.refs.set(ref, commitOid);
    return { commitOid };
  }

  /** Read a path at a commit: a file, a directory listing, or null. */
  contentsRead(
    repo: Repo,
    commitOid: string,
    path: string,
  ): { kind: 'file'; blobOid: string; size: number } | { kind: 'dir'; entries: TreeEntry[] } | null {
    const tree = this.commitTree(repo, commitOid);
    if (tree === null) return null;
    const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
    if (segments.length === 0) {
      const object = repo.objects.get(tree);
      if (object === undefined || object.type !== 'tree') return null;
      return { kind: 'dir', entries: parseTree(object.data) };
    }
    const files = this.flattenTree(repo, tree);
    const file = files.get(segments.join('/'));
    if (file !== undefined) {
      const blob = repo.objects.get(file.oid);
      return { kind: 'file', blobOid: file.oid, size: blob === undefined ? 0 : blob.data.length };
    }
    // Maybe a directory: walk the tree.
    let current = tree;
    for (const segment of segments) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
      if (entry === undefined) return null;
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    return { kind: 'dir', entries: parseTree(object.data) };
  }

  // ------------------------------------------------------------ global ids

  repoGlobalId(repo: Repo): string {
    return `R_${repo.id}`;
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return `I_${repo.id}_${issue.number}`;
  }

  pullGlobalId(repo: Repo, pull: Pull): string {
    return `PR_${repo.id}_${pull.number}`;
  }

  commentGlobalId(comment: Comment): string {
    return `IC_${comment.id}`;
  }

  /** Resolve a global id to a repo / issue / pull / comment. */
  resolveGlobalId(id: string): { repo: Repo; issue?: Issue; pull?: Pull; comment?: Comment } | null {
    if (id.startsWith('R_')) {
      const repo = this.repoById.get(Number(id.slice(2)));
      return repo === undefined ? null : { repo };
    }
    if (id.startsWith('PR_')) {
      const rest = id.slice(3).split('_');
      const repo = this.repoById.get(Number(rest[0]));
      if (repo === undefined) return null;
      const pull = repo.pulls.find((candidate) => candidate.number === Number(rest[1]));
      return pull === undefined ? null : { repo, pull };
    }
    if (id.startsWith('I_')) {
      const rest = id.slice(2).split('_');
      const repo = this.repoById.get(Number(rest[0]));
      if (repo === undefined) return null;
      const issue = repo.issues.find((candidate) => candidate.number === Number(rest[1]));
      return issue === undefined ? null : { repo, issue };
    }
    if (id.startsWith('IC_')) {
      const commentId = Number(id.slice(3));
      for (const repo of this.repos.values()) {
        for (const issue of repo.issues) {
          const comment = issue.comments.find((candidate) => candidate.id === commentId);
          if (comment !== undefined) return { repo, issue, comment };
        }
        for (const pull of repo.pulls) {
          const comment = pull.comments.find((candidate) => candidate.id === commentId);
          if (comment !== undefined) return { repo, pull, comment };
        }
      }
      return null;
    }
    return null;
  }
}
