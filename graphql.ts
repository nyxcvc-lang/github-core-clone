// GraphQL over POST /api/graphql: a small executor for the fixed documents the suite
// sends (queries + mutations with variables, aliases, inline fragments, __type, node(id:),
// batch arrays). Unknown fields answer HTTP 200 with an errors array naming the field;
// an unknown repository answers data.repository = null with no errors.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { FIXED_ISO, type Issue, type Pull, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}():$![]=@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += source[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------- AST

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldSel {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentSel {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldSel | FragmentSel;

interface Operation {
  opType: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

class Parser {
  tokens: Token[];
  pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  skipPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  parseOperation(): Operation {
    let opType: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '{') {
      return { opType, name, selections: this.parseSelectionSet() };
    }
    const keyword = this.expectName();
    if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
      throw new Error(`unsupported operation ${keyword}`);
    }
    opType = keyword === 'mutation' ? 'mutation' : 'query';
    const next = this.peek();
    if (next !== undefined && next.kind === 'name') name = this.expectName();
    // Variable definitions: ($x: Type = default, ...) — parsed and discarded.
    if (this.skipPunct('(')) {
      let depth = 1;
      while (depth > 0) {
        const t = this.next();
        if (t.kind === 'punct' && t.value === '(') depth += 1;
        else if (t.kind === 'punct' && t.value === ')') depth -= 1;
      }
    }
    // Directives: @name(args) — skipped.
    while (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.skipPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          else if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    return { opType, name, selections: this.parseSelectionSet() };
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): SelectionNode {
    const token = this.peek();
    if (token !== undefined && token.kind === 'spread') {
      this.next();
      let typeCondition: string | null = null;
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      // Directives on a fragment: skipped.
      while (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
        this.next();
        this.expectName();
        if (this.skipPunct('(')) {
          let depth = 1;
          while (depth > 0) {
            const t = this.next();
            if (t.kind === 'punct' && t.value === '(') depth += 1;
            else if (t.kind === 'punct' && t.value === ')') depth -= 1;
          }
        }
      }
      return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.skipPunct('(')) {
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives on a field: skipped.
    while (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.skipPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          else if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    let selections: SelectionNode[] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

type Variables = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldSel, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------- values

type GqlValue = Record<string, unknown> | null;

interface ExecutorContext {
  store: Store;
  viewerLogin: string;
}

const ISSUE_TYPE_FIELDS = ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'url', 'createdAt', 'comments'];
const PULL_TYPE_FIELDS = ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'author', 'url', 'createdAt'];
const REPO_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC', 'PACKAGE'];

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function issueValue(ctx: ExecutorContext, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: ctx.store.issueGlobalId(repo, issue),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    author: { __typename: 'User', login: issue.user },
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: FIXED_ISO,
  };
}

function pullValue(ctx: ExecutorContext, repo: Repo, pull: Pull): Record<string, unknown> {
  const merged = pull.merged;
  const state = merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
  let mergeable = 'UNKNOWN';
  if (!merged && pull.state === 'open') {
    mergeable = ctx.store.mergePlan(repo, pull).conflict ? 'CONFLICTING' : 'MERGEABLE';
  }
  return {
    __typename: 'PullRequest',
    id: ctx.store.pullGlobalId(repo, pull),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state,
    merged,
    mergeable,
    headRefName: pull.head,
    baseRefName: pull.base,
    author: { __typename: 'User', login: pull.user },
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    createdAt: FIXED_ISO,
    files: (args: Record<string, unknown>) => {
      const first = typeof args.first === 'number' ? args.first : 10;
      const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
      const base = ctx.store.mergeBase(repo, headTip, baseTip);
      const baseTree = base === null ? null : ctx.store.commitTree(repo, base);
      const headTree = ctx.store.commitTree(repo, headTip);
      const files = ctx.store.diffTrees(repo, baseTree, headTree);
      return {
        __typename: 'PullRequestFilesConnection',
        nodes: files.slice(0, first).map((file) => ({ __typename: 'PullRequestFile', path: file.path })),
        totalCount: files.length,
      };
    },
  };
}

function issuesConnection(
  ctx: ExecutorContext,
  repo: Repo,
  args: Record<string, unknown>,
): Record<string, unknown> {
  let items = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    items = items.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy;
  let direction = 'ASC';
  if (orderBy !== null && typeof orderBy === 'object' && !Array.isArray(orderBy)) {
    direction = String((orderBy as Record<string, unknown>).direction ?? 'ASC');
  }
  items.sort((a, b) => (direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
  const after = decodeCursor(args.after);
  if (after !== null) {
    items = direction === 'DESC' ? items.filter((issue) => issue.number < after) : items.filter((issue) => issue.number > after);
  }
  const first = typeof args.first === 'number' ? args.first : items.length;
  const page = items.slice(0, first);
  const hasNextPage = items.length > page.length;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueValue(ctx, repo, issue)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]?.number ?? 0) : null,
    },
    totalCount: items.length,
  };
}

function pullsConnection(
  ctx: ExecutorContext,
  repo: Repo,
  args: Record<string, unknown>,
): Record<string, unknown> {
  let items = [...repo.pulls];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    items = items.filter((pull) => {
      const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      return wanted.has(state);
    });
  }
  const first = typeof args.first === 'number' ? args.first : items.length;
  const page = items.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullValue(ctx, repo, pull)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: items.length > page.length,
      endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]?.number ?? 0) : null,
    },
    totalCount: items.length,
  };
}

function repoValue(ctx: ExecutorContext, repo: Repo): Record<string, unknown> {
  return {
    __typename: 'Repository',
    id: ctx.store.repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    owner: { __typename: 'User', login: repo.owner },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    createdAt: FIXED_ISO,
    issue: (args: Record<string, unknown>) => {
      const issue = typeof args.number === 'number' ? ctx.store.findIssue(repo, args.number) : undefined;
      return issue === undefined ? null : issueValue(ctx, repo, issue);
    },
    issues: (args: Record<string, unknown>) => issuesConnection(ctx, repo, args),
    pullRequests: (args: Record<string, unknown>) => pullsConnection(ctx, repo, args),
    pullRequest: (args: Record<string, unknown>) => {
      const pull = typeof args.number === 'number' ? ctx.store.findPull(repo, args.number) : undefined;
      return pull === undefined ? null : pullValue(ctx, repo, pull);
    },
  };
}

function typeValue(name: string): Record<string, unknown> {
  const fields =
    name === 'Issue' ? ISSUE_TYPE_FIELDS : name === 'PullRequest' ? PULL_TYPE_FIELDS : name === 'Repository' ? REPO_TYPE_FIELDS : [];
  return {
    __typename: '__Type',
    name,
    kind: 'OBJECT',
    fields: () => fields.map((field) => ({ __typename: '__Field', name: field })),
    enumValues: () => (name === 'SearchType' ? SEARCH_TYPE_VALUES.map((value) => ({ __typename: '__EnumValue', name: value })) : []),
  };
}

function nodeValue(ctx: ExecutorContext, id: string): Record<string, unknown> | null {
  const resolved = ctx.store.resolveGlobalId(id);
  if (resolved === null) return null;
  if (resolved.pull !== undefined) return pullValue(ctx, resolved.repo, resolved.pull);
  if (resolved.issue !== undefined) return issueValue(ctx, resolved.repo, resolved.issue);
  if (resolved.comment !== undefined) {
    return {
      __typename: 'IssueComment',
      id: ctx.store.commentGlobalId(resolved.comment),
      databaseId: resolved.comment.id,
      body: resolved.comment.body,
    };
  }
  return repoValue(ctx, resolved.repo);
}

// ---------------------------------------------------------------- execution

interface GraphQLError {
  message: string;
}

function project(
  selections: SelectionNode[],
  value: GqlValue,
  variables: Variables,
  errors: GraphQLError[],
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => project(selections, entry as GqlValue, variables, errors));
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== (value as Record<string, unknown>).__typename) continue;
      const projected = project(selection.selections, value, variables, errors) as Record<string, unknown>;
      Object.assign(out, projected);
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[responseKey] = (value as Record<string, unknown>).__typename ?? null;
      continue;
    }
    const raw = (value as Record<string, unknown>)[selection.name];
    if (raw === undefined) {
      errors.push({ message: `Cannot query field "${selection.name}" on type "${String((value as Record<string, unknown>).__typename ?? 'Unknown')}".` });
      out[responseKey] = null;
      continue;
    }
    const resolved = typeof raw === 'function' ? (raw as (args: Record<string, unknown>) => unknown)(resolveArgs(selection, variables)) : raw;
    if (selection.selections.length === 0) {
      out[responseKey] = resolved;
    } else if (resolved === null || resolved === undefined) {
      out[responseKey] = null;
    } else if (Array.isArray(resolved)) {
      out[responseKey] = resolved.map((entry) => project(selection.selections, entry as GqlValue, variables, errors));
    } else if (typeof resolved === 'object') {
      out[responseKey] = project(selection.selections, resolved as GqlValue, variables, errors);
    } else {
      out[responseKey] = resolved;
    }
  }
  return out;
}

function resolveRootField(
  ctx: ExecutorContext,
  field: FieldSel,
  variables: Variables,
  errors: GraphQLError[],
): { found: boolean; value: GqlValue } {
  const args = resolveArgs(field, variables);
  switch (field.name) {
    case 'viewer':
      return { found: true, value: { __typename: 'Viewer', login: ctx.viewerLogin } };
    case 'repository': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = ctx.store.getRepo(owner, name);
      if (repo === undefined || owner !== ctx.viewerLogin) return { found: true, value: null };
      return { found: true, value: repoValue(ctx, repo) };
    }
    case 'node': {
      const id = typeof args.id === 'string' ? args.id : '';
      return { found: true, value: nodeValue(ctx, id) };
    }
    case '__type': {
      const name = typeof args.name === 'string' ? args.name : '';
      return { found: true, value: typeValue(name) };
    }
    case 'createIssue': {
      const input = args.input as Record<string, unknown> | undefined;
      const repositoryId = typeof input?.repositoryId === 'string' ? input.repositoryId : '';
      const resolved = ctx.store.resolveGlobalId(repositoryId);
      if (resolved === null) {
        errors.push({ message: `repository ${repositoryId} not found` });
        return { found: true, value: null };
      }
      const title = typeof input?.title === 'string' ? input.title : '';
      const body = typeof input?.body === 'string' ? input.body : '';
      const issue = ctx.store.createIssue(resolved.repo, title, body, []);
      return {
        found: true,
        value: { __typename: 'CreateIssuePayload', issue: issueValue(ctx, resolved.repo, issue) },
      };
    }
    case 'closeIssue': {
      const input = args.input as Record<string, unknown> | undefined;
      const issueId = typeof input?.issueId === 'string' ? input.issueId : '';
      const resolved = ctx.store.resolveGlobalId(issueId);
      if (resolved === null || resolved.issue === undefined) {
        errors.push({ message: `issue ${issueId} not found` });
        return { found: true, value: null };
      }
      resolved.issue.state = 'closed';
      return {
        found: true,
        value: { __typename: 'CloseIssuePayload', issue: issueValue(ctx, resolved.repo, resolved.issue) },
      };
    }
    case 'createPullRequest': {
      const input = args.input as Record<string, unknown> | undefined;
      const repositoryId = typeof input?.repositoryId === 'string' ? input.repositoryId : '';
      const resolved = ctx.store.resolveGlobalId(repositoryId);
      if (resolved === null) {
        errors.push({ message: `repository ${repositoryId} not found` });
        return { found: true, value: null };
      }
      const repo = resolved.repo;
      const head = typeof input?.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input?.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input?.title === 'string' ? input.title : '';
      const body = typeof input?.body === 'string' ? input.body : '';
      let pull = repo.pulls.find((candidate) => candidate.state === 'open' && !candidate.merged && candidate.head === head && candidate.base === base);
      if (pull === undefined) {
        const created = ctx.store.createPull(repo, head, base, title, body);
        if (created === null) {
          errors.push({ message: `cannot create pull request from ${head} to ${base}` });
          return { found: true, value: null };
        }
        pull = created;
      }
      return {
        found: true,
        value: { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(ctx, repo, pull) },
      };
    }
    case 'mergePullRequest': {
      const input = args.input as Record<string, unknown> | undefined;
      const pullRequestId = typeof input?.pullRequestId === 'string' ? input.pullRequestId : '';
      const resolved = ctx.store.resolveGlobalId(pullRequestId);
      if (resolved === null || resolved.pull === undefined) {
        errors.push({ message: `pull request ${pullRequestId} not found` });
        return { found: true, value: null };
      }
      const pull = resolved.pull;
      if (pull.merged) {
        return {
          found: true,
          value: { __typename: 'MergePullRequestPayload', pullRequest: pullValue(ctx, resolved.repo, pull) },
        };
      }
      const plan = ctx.store.mergePlan(resolved.repo, pull);
      if (plan.conflict) {
        errors.push({ message: 'merge conflict' });
        return { found: true, value: { __typename: 'MergePullRequestPayload', pullRequest: null } };
      }
      const mergeOid = ctx.store.doMerge(resolved.repo, pull);
      if (mergeOid === null) {
        errors.push({ message: 'merge conflict' });
        return { found: true, value: { __typename: 'MergePullRequestPayload', pullRequest: null } };
      }
      pull.merged = true;
      pull.mergedAt = FIXED_ISO;
      pull.mergeSha = mergeOid;
      pull.state = 'closed';
      return {
        found: true,
        value: { __typename: 'MergePullRequestPayload', pullRequest: pullValue(ctx, resolved.repo, pull) },
      };
    }
    case 'addComment': {
      const input = args.input as Record<string, unknown> | undefined;
      const subjectId = typeof input?.subjectId === 'string' ? input.subjectId : '';
      const body = typeof input?.body === 'string' ? input.body : '';
      const resolved = ctx.store.resolveGlobalId(subjectId);
      if (resolved === null || (resolved.issue === undefined && resolved.pull === undefined)) {
        errors.push({ message: `subject ${subjectId} not found` });
        return { found: true, value: null };
      }
      const item = (resolved.issue ?? resolved.pull) as Issue | Pull;
      const comment = ctx.store.addComment(item, body);
      return {
        found: true,
        value: {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: {
              __typename: 'IssueComment',
              id: ctx.store.commentGlobalId(comment),
              databaseId: comment.id,
              body: comment.body,
            },
          },
        },
      };
    }
    default:
      return { found: false, value: null };
  }
}

function executeOne(
  ctx: ExecutorContext,
  operation: Operation,
  variables: Variables,
): { data: Record<string, unknown> | null; errors?: GraphQLError[] } {
  const errors: GraphQLError[] = [];
  const data: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind === 'fragment') {
      const projected = project(selection.selections, { __typename: 'Query' } as GqlValue, variables, errors);
      Object.assign(data, projected as Record<string, unknown>);
      continue;
    }
    const resolved = resolveRootField(ctx, selection, variables, errors);
    if (!resolved.found) {
      errors.push({ message: `Cannot query field "${selection.name}" on type "Query".` });
      data[selection.alias ?? selection.name] = null;
      continue;
    }
    if (selection.selections.length === 0) {
      data[selection.alias ?? selection.name] = resolved.value;
    } else if (resolved.value === null) {
      data[selection.alias ?? selection.name] = null;
    } else {
      data[selection.alias ?? selection.name] = project(selection.selections, resolved.value, variables, errors);
    }
  }
  return errors.length > 0 ? { data, errors } : { data };
}

/** POST /api/graphql. `body` is the parsed JSON request (object or batch array). */
export function handleGraphql(
  ctx: ExecutorContext,
  _req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): void {
  const requestId = ctx.store.requestId();
  const send = (status: number, payload: unknown): void => {
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-github-request-id': requestId,
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  };
  const run = (request: unknown): unknown => {
    if (typeof request !== 'object' || request === null || Array.isArray(request)) {
      return { data: null, errors: [{ message: 'request must be a JSON object' }] };
    }
    const query = (request as Record<string, unknown>).query;
    if (typeof query !== 'string' || query === '') {
      return { data: null, errors: [{ message: 'query is required' }] };
    }
    const variables = (request as Record<string, unknown>).variables;
    const vars: Variables = variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Variables) : {};
    let operations: Operation[];
    try {
      operations = new Parser(query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
    }
    if (operations.length === 0) return { data: null, errors: [{ message: 'empty document' }] };
    const operationName = (request as Record<string, unknown>).operationName;
    let operation = operations[0] as Operation;
    if (typeof operationName === 'string' && operationName !== '') {
      operation = operations.find((candidate) => candidate.name === operationName) ?? operation;
    }
    try {
      return executeOne(ctx, operation, vars);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'execution error' }] };
    }
  };
  if (Array.isArray(body)) {
    send(200, body.map((request) => run(request)));
    return;
  }
  send(200, run(body));
}
