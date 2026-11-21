/**
 * The scope rules (safeguard 3), as a pure function over a list of changed paths. Every added, changed or
 * deleted path must:
 * - be inside one of the task's owned paths (a read-only task owns nothing);
 * - not be git metadata;
 * - for a normal task, not be a reserved file, even inside an owned folder (a manifest or an agent
 *   instruction file in a sub-folder is still reserved);
 * - not be a symlink or a nested repository;
 * - if new, have a name Windows can create, and not clash with another path when letter case is ignored.
 */

import { DEFAULT_RESERVED_PATTERNS, FORBIDDEN_PATTERNS } from '../config/defaults.js';
import { covers, parseOwnsEntry, PATH_ISSUE_TEXT, toKey, windowsPathIssue, type OwnsEntry } from '../plan/paths.js';
import { compilePatterns } from '../plan/reserved.js';
import type { Task } from '../plan/schema.js';
import type { TreeChange } from './diff.js';

export interface ScopeRules {
  readonly reservedPatterns: readonly string[];
  readonly forbiddenPatterns: readonly string[];
}

export const DEFAULT_SCOPE_RULES: ScopeRules = {
  reservedPatterns: DEFAULT_RESERVED_PATTERNS,
  forbiddenPatterns: FORBIDDEN_PATTERNS,
};

export type ScopeTask = Pick<Task, 'id' | 'kind' | 'mode' | 'owns'>;

export type ScopeViolationCode =
  | 'outside-owns'
  | 'forbidden'
  | 'reserved'
  | 'symlink'
  | 'submodule'
  | 'bad-name'
  | 'case-collision';

export interface ScopeViolation {
  readonly path: string;
  readonly code: ScopeViolationCode;
  readonly message: string;
}

const SYMLINK_MODE = '120000';
const GITLINK_MODE = '160000';
const VERB: Record<TreeChange['status'], string> = {
  A: 'Added',
  D: 'Deleted',
  M: 'Changed',
  T: 'Changed the type of',
};

function fileEntry(path: string): OwnsEntry {
  const nfc = path.normalize('NFC');
  return { path: nfc, key: toKey(nfc), isFolder: false };
}

/** Every spelling of each path and parent folder in the tree, grouped by comparison key. */
function spellingsByKey(treePaths: readonly string[]): Map<string, Set<string>> {
  const spellings = new Map<string, Set<string>>();
  for (const path of treePaths) {
    const parts = path.split('/');
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join('/');
      const key = toKey(prefix.normalize('NFC'));
      const set = spellings.get(key) ?? new Set<string>();
      set.add(prefix);
      spellings.set(key, set);
    }
  }
  return spellings;
}

/** For each added path, the spellings it clashes with (itself or a parent folder), if any. */
export function caseCollisions(added: readonly string[], treePaths: readonly string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  if (added.length === 0) return found;
  const spellings = spellingsByKey(treePaths);
  for (const path of added) {
    const parts = path.split('/');
    for (let depth = 1; depth <= parts.length; depth++) {
      const set = spellings.get(toKey(parts.slice(0, depth).join('/').normalize('NFC')));
      if (set !== undefined && set.size > 1) {
        found.set(path, [...set].sort());
        break;
      }
    }
  }
  return found;
}

/**
 * Checks changes against a task's scope. `treePaths` lists every path in the new tree; it is only needed
 * when paths were added (to find case clashes) and may be empty otherwise.
 */
export function evaluateScope(
  task: ScopeTask,
  changes: readonly TreeChange[],
  rules: ScopeRules = DEFAULT_SCOPE_RULES,
  treePaths: readonly string[] = [],
): ScopeViolation[] {
  const owned = task.owns.flatMap((raw) => {
    const parsed = parseOwnsEntry(raw);
    return parsed.ok ? [parsed.entry] : [];
  });
  const reserved = compilePatterns(rules.reservedPatterns);
  const forbidden = compilePatterns(rules.forbiddenPatterns);
  const violations: ScopeViolation[] = [];
  const addedInScope: string[] = [];

  for (const change of changes) {
    const { path } = change;
    const entry = fileEntry(path);
    const forbiddenBy = forbidden.match(entry);
    if (forbiddenBy !== null) {
      violations.push({ path, code: 'forbidden', message: `${VERB[change.status]} "${path}", which is git metadata.` });
      continue;
    }
    if (!owned.some((o) => covers(o, entry))) {
      const why = task.mode === 'readonly' ? 'but this task is read-only' : 'which this task does not own';
      violations.push({ path, code: 'outside-owns', message: `${VERB[change.status]} "${path}", ${why}.` });
      continue;
    }
    const reservedBy = task.kind === 'work' ? reserved.match(entry) : null;
    if (reservedBy !== null) {
      violations.push({
        path,
        code: 'reserved',
        message: `${VERB[change.status]} "${path}", a reserved file (matches "${reservedBy}"). Only a separate reserved run may change it.`,
      });
    }
    if (change.status !== 'D' && change.newMode === SYMLINK_MODE) {
      violations.push({ path, code: 'symlink', message: `"${path}" is a symbolic link; tasks may not add or change links.` });
    }
    if (change.status !== 'D' && change.newMode === GITLINK_MODE) {
      violations.push({ path, code: 'submodule', message: `"${path}" is a nested repository (a submodule entry).` });
    }
    if (change.status === 'A') {
      addedInScope.push(path);
      const issue = windowsPathIssue(path);
      if (issue !== null) violations.push({ path, code: 'bad-name', message: `"${path}" ${PATH_ISSUE_TEXT[issue]}.` });
    }
  }

  for (const [path, spellings] of caseCollisions(addedInScope, treePaths)) {
    violations.push({
      path,
      code: 'case-collision',
      message: `"${path}" clashes with ${spellings.map((s) => `"${s}"`).join(' and ')} when letter case is ignored (Windows, macOS).`,
    });
  }
  return violations;
}
