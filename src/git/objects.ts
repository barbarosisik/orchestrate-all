/**
 * Reading git objects without trusting the object store.
 *
 * Workers can write to the repository's shared objects folder: any commit made in a worktree writes there.
 * Git doesn't re-hash the objects it reads, so an object file rewritten under an existing id makes git see
 * other content: for a tree, other paths. Before trusting what git reports about a commit, the conductor
 * reads the commit and every tree below it itself and checks that each one hashes to its id.
 *
 * File contents (blobs) are not re-hashed: they don't change which paths a commit touches.
 */

import { createHash } from 'node:crypto';
import { repoGitRaw, type RepoContext } from './context.js';
import { describeGitFailure, LONG_GIT_TIMEOUT_MS } from './run.js';

export type ObjectProblemCode = 'missing' | 'wrong-type' | 'altered' | 'git-failed';

export interface ObjectProblem {
  readonly code: ObjectProblemCode;
  readonly message: string;
}

export type ObjectCheck<T> = ({ ok: true } & T) | { ok: false; problem: ObjectProblem };

export interface GitObject {
  readonly type: string;
  readonly content: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  /** The entry's name as stored (bytes, usually UTF-8). */
  readonly name: Buffer;
  readonly id: string;
}

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
}

const FULL_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TREE_MODE = '40000';

function problem(code: ObjectProblemCode, message: string): { ok: false; problem: ObjectProblem } {
  return { ok: false, problem: { code, message } };
}

function short(id: string): string {
  return id.slice(0, 12);
}

/** The id git gives an object: SHA-1 (40 hex digits) or SHA-256 (64), over "<type> <size>\0<content>". */
export function objectId(type: string, content: Buffer, algorithm: 'sha1' | 'sha256'): string {
  return createHash(algorithm).update(`${type} ${content.length}\u0000`).update(content).digest('hex');
}

/**
 * Splits `git cat-file --batch` output into objects, keyed by id. A missing object is absent from the map.
 * Throws on output that doesn't follow the format.
 */
export function parseBatchOutput(output: Buffer): Map<string, GitObject> {
  const objects = new Map<string, GitObject>();
  let pos = 0;
  while (pos < output.length) {
    const end = output.indexOf(0x0a, pos);
    if (end === -1) throw new Error('Unexpected end of git cat-file output.');
    const header = output.subarray(pos, end).toString('utf8');
    pos = end + 1;
    const fields = header.split(' ');
    if (fields.length === 2 && fields[1] === 'missing') continue;
    const [id, type, sizeText] = fields;
    const size = Number(sizeText);
    if (fields.length !== 3 || id === undefined || type === undefined || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Unexpected git cat-file header: ${header.slice(0, 80)}`);
    }
    if (pos + size + 1 > output.length || output[pos + size] !== 0x0a) {
      throw new Error(`git cat-file output for ${short(id)} is cut short.`);
    }
    objects.set(id, { type, content: output.subarray(pos, pos + size) });
    pos += size + 1;
  }
  return objects;
}

/** Parses a tree object's entries. Returns null if the content isn't a well-formed tree. */
export function parseTree(content: Buffer, idBytes: number): TreeEntry[] | null {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < content.length) {
    const space = content.indexOf(0x20, pos);
    const nul = space === -1 ? -1 : content.indexOf(0x00, space + 1);
    if (space <= pos || nul === -1 || nul === space + 1 || nul + 1 + idBytes > content.length) return null;
    const mode = content.subarray(pos, space).toString('latin1');
    if (!/^[0-7]{5,6}$/.test(mode)) return null;
    entries.push({
      mode,
      name: content.subarray(space + 1, nul),
      id: content.subarray(nul + 1, nul + 1 + idBytes).toString('hex'),
    });
    pos = nul + 1 + idBytes;
  }
  return entries;
}

/** Reads objects and checks that each one hashes to its id. */
export async function readVerifiedObjects(
  ctx: RepoContext,
  ids: readonly string[],
): Promise<ObjectCheck<{ objects: Map<string, GitObject> }>> {
  if (ids.length === 0) return { ok: true, objects: new Map() };
  for (const id of ids) if (!FULL_ID.test(id)) return problem('missing', `"${id}" is not a full object id.`);
  const result = await repoGitRaw(ctx, ['cat-file', '--batch'], {
    input: `${ids.join('\n')}\n`,
    timeoutMs: LONG_GIT_TIMEOUT_MS,
  });
  if (result.code !== 0) return problem('git-failed', `git cat-file failed: ${describeGitFailure(result)}`);
  let objects: Map<string, GitObject>;
  try {
    objects = parseBatchOutput(result.stdout);
  } catch (error) {
    return problem('git-failed', error instanceof Error ? error.message : String(error));
  }
  for (const id of ids) {
    const object = objects.get(id);
    if (object === undefined) return problem('missing', `Object ${short(id)} is not in this repository.`);
    if (objectId(object.type, object.content, id.length === 40 ? 'sha1' : 'sha256') !== id) {
      return problem(
        'altered',
        `Git object ${short(id)} does not match its id: the repository's object store was changed or is damaged ` +
          '(git fsck shows more).',
      );
    }
  }
  return { ok: true, objects };
}

/** Reads a commit and returns its tree and parents, after checking the commit hashes to its id. */
export async function readCommit(ctx: RepoContext, id: string): Promise<ObjectCheck<CommitInfo>> {
  const read = await readVerifiedObjects(ctx, [id]);
  if (!read.ok) return read;
  const object = read.objects.get(id) as GitObject;
  if (object.type !== 'commit') return problem('wrong-type', `${short(id)} is a ${object.type}, not a commit.`);
  const headerEnd = object.content.indexOf('\n\n');
  const lines = object.content.subarray(0, headerEnd === -1 ? object.content.length : headerEnd).toString('utf8').split('\n');
  const tree = /^tree ([0-9a-f]+)$/.exec(lines[0] ?? '')?.[1];
  if (tree === undefined || tree.length !== id.length) return problem('altered', `Commit ${short(id)} has no valid tree line.`);
  const parents: string[] = [];
  for (const line of lines.slice(1)) {
    const parent = /^parent ([0-9a-f]+)$/.exec(line)?.[1];
    if (parent === undefined) break;
    parents.push(parent);
  }
  return { ok: true, tree, parents };
}

/**
 * Checks a tree and every tree below it, one level per git call. Ids in `verified` are skipped, and every
 * tree checked is added to it, so two trees that share folders are read once.
 */
export async function verifyTree(
  ctx: RepoContext,
  root: string,
  verified: Set<string> = new Set(),
): Promise<ObjectCheck<{ trees: number }>> {
  let level = verified.has(root) ? [] : [root];
  let trees = 0;
  while (level.length > 0) {
    const read = await readVerifiedObjects(ctx, level);
    if (!read.ok) return read;
    const next = new Set<string>();
    for (const id of level) {
      const object = read.objects.get(id) as GitObject;
      if (object.type !== 'tree') return problem('wrong-type', `${short(id)} is a ${object.type}, not a tree.`);
      const entries = parseTree(object.content, id.length / 2);
      if (entries === null) return problem('altered', `Tree ${short(id)} is not a well-formed tree.`);
      verified.add(id);
      trees += 1;
      for (const entry of entries) {
        if (entry.mode === TREE_MODE && !verified.has(entry.id)) next.add(entry.id);
      }
    }
    level = [...next];
  }
  return { ok: true, trees };
}
