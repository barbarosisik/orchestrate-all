/**
 * Plan validation (safeguard 1). Pure: no git, no file system. Repository checks (branch tip,
 * dirty owned paths) run separately and add the base commit before the plan is hashed.
 */

import { posix, win32 } from 'node:path';
import type { z } from 'zod';
import { dependsTransitively, findCycle } from './graph.js';
import {
  entriesOverlap,
  isWindowsDeviceName,
  minimizeEntries,
  parseOwnsEntry,
  PATH_ISSUE_TEXT,
  type OwnsEntry,
} from './paths.js';
import { compilePatterns } from './reserved.js';
import { PlanSchema, type EngineName, type PlanInput, type Task } from './schema.js';
import { checkEvenSplit } from './split.js';

export interface ValidationContext {
  /** Engines that are installed and signed in (or have their key) right now. */
  readonly readyEngines: readonly EngineName[];
  readonly reservedPatterns: readonly string[];
  readonly forbiddenPatterns: readonly string[];
  readonly maxTasks: number;
  /** "ordered": overlap allowed only along dependencies. "strict": no overlap at all. */
  readonly overlapMode: 'ordered' | 'strict';
  /** "even": enforce the even split across ready engines. "off": skip it (e.g. compare mode). */
  readonly splitMode: 'even' | 'off';
}

export type ValidationErrorCode =
  | 'schema'
  | 'task-limit'
  | 'duplicate-id'
  | 'reserved-id'
  | 'bad-repo-path'
  | 'bad-branch'
  | 'owns-invalid'
  | 'owns-mode'
  | 'owns-forbidden'
  | 'owns-reserved'
  | 'reserved-run'
  | 'dep-unknown'
  | 'dep-self'
  | 'dep-duplicate'
  | 'dep-cycle'
  | 'no-engines'
  | 'engine-not-ready'
  | 'uneven-split'
  | 'overlap-unordered'
  | 'overlap-strict'
  // Repository checks (src/repo/checks.ts)
  | 'repo-missing'
  | 'not-a-git-repo'
  | 'bare-repo'
  | 'repo-not-toplevel'
  | 'branch-missing'
  | 'dirty-owned'
  | 'git-failed';

export interface ValidationError {
  /** Where the problem is, e.g. "tasks[1].owns[0]". */
  readonly path: string;
  readonly code: ValidationErrorCode;
  readonly message: string;
}

export type NormalizedTask = Task;
/** The plan as accepted: owned paths normalized and minimized, any model-supplied baseSha removed. */
export type NormalizedPlan = Omit<PlanInput, 'baseSha'>;

export type ValidationResult = { ok: true; plan: NormalizedPlan } | { ok: false; errors: ValidationError[] };

/** Ids Orchestra uses for its own branches (`orchestra/<runId>/integration`). */
export const RESERVED_TASK_IDS: ReadonlySet<string> = new Set(['integration']);
const BRANCH_FORBIDDEN_CHARS = /[\u0000- \u007f~^:?*[\\]/;

function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out.length === 0 ? String(part) : `.${String(part)}`;
  }
  return out;
}

function schemaErrors(error: z.ZodError): ValidationError[] {
  return error.issues.map((issue) => ({
    path: formatPath(issue.path),
    code: 'schema' as const,
    message: issue.message,
  }));
}

/** A conservative version of `git check-ref-format --branch`, plus Orchestra's own namespace. */
export function branchNameProblem(name: string): string | null {
  if (name.length === 0) return 'is empty';
  if (name.length > 200) return 'is longer than 200 characters';
  if (BRANCH_FORBIDDEN_CHARS.test(name)) return 'contains a space, control character or one of ~ ^ : ? * [ \\';
  if (name.includes('..')) return 'contains ".."';
  if (name.includes('@{') || name === '@') return 'contains "@{" or is "@"';
  if (name.startsWith('-')) return 'starts with "-"';
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return 'has an empty path component';
  if (name.endsWith('.')) return 'ends with "."';
  for (const component of name.split('/')) {
    if (component.startsWith('.')) return 'has a component starting with "."';
    if (component.endsWith('.lock')) return 'has a component ending with ".lock"';
  }
  if (name.toLowerCase().startsWith('orchestra/')) return 'is inside Orchestra’s own "orchestra/" namespace';
  return null;
}

function isAbsoluteRepoPath(path: string): boolean {
  return win32.isAbsolute(path) && /^([A-Za-z]:[\\/]|\\\\)/.test(path) ? true : posix.isAbsolute(path);
}

interface ParsedTask {
  readonly index: number;
  readonly task: Task;
  readonly entries: ReadonlyArray<{ readonly entry: OwnsEntry; readonly ownsIndex: number }>;
}

function checkIdentity(plan: PlanInput, ctx: ValidationContext, errors: ValidationError[]): void {
  if (plan.tasks.length > ctx.maxTasks) {
    errors.push({
      path: 'tasks',
      code: 'task-limit',
      message: `The plan has ${plan.tasks.length} tasks; the limit is ${ctx.maxTasks}. Merge related tasks.`,
    });
  }
  if (!isAbsoluteRepoPath(plan.repo)) {
    errors.push({ path: 'repo', code: 'bad-repo-path', message: `"${plan.repo}" is not an absolute path.` });
  }
  const branchProblem = branchNameProblem(plan.targetBranch);
  if (branchProblem !== null) {
    errors.push({
      path: 'targetBranch',
      code: 'bad-branch',
      message: `Target branch "${plan.targetBranch}" ${branchProblem}.`,
    });
  }
  const seen = new Set<string>();
  plan.tasks.forEach((task, i) => {
    if (seen.has(task.id)) {
      errors.push({ path: `tasks[${i}].id`, code: 'duplicate-id', message: `Task id "${task.id}" is used twice.` });
    }
    seen.add(task.id);
    if (RESERVED_TASK_IDS.has(task.id)) {
      errors.push({ path: `tasks[${i}].id`, code: 'reserved-id', message: `"${task.id}" is reserved by Orchestra.` });
    } else if (isWindowsDeviceName(task.id)) {
      // Task ids become folder names (the task's worktree), and Windows can't create a folder with this name.
      errors.push({
        path: `tasks[${i}].id`,
        code: 'reserved-id',
        message: `"${task.id}" is a reserved Windows device name and can't be used as a folder name.`,
      });
    }
  });
}

function parseTasksOwns(plan: PlanInput, ctx: ValidationContext, errors: ValidationError[]): ParsedTask[] {
  const reserved = compilePatterns(ctx.reservedPatterns);
  const forbidden = compilePatterns(ctx.forbiddenPatterns);

  return plan.tasks.map((task, index) => {
    const entries: Array<{ entry: OwnsEntry; ownsIndex: number }> = [];
    task.owns.forEach((raw, ownsIndex) => {
      const where = `tasks[${index}].owns[${ownsIndex}]`;
      const parsed = parseOwnsEntry(raw);
      if (!parsed.ok) {
        errors.push({ path: where, code: 'owns-invalid', message: `"${raw}" ${PATH_ISSUE_TEXT[parsed.issue]}.` });
        return;
      }
      const forbiddenBy = forbidden.match(parsed.entry);
      if (forbiddenBy !== null) {
        errors.push({
          path: where,
          code: 'owns-forbidden',
          message: `"${parsed.entry.path}" is git metadata (matches "${forbiddenBy}"); no task may own it.`,
        });
        return;
      }
      const reservedBy = reserved.match(parsed.entry);
      if (reservedBy !== null && task.kind === 'work') {
        errors.push({
          path: where,
          code: 'owns-reserved',
          message:
            `"${parsed.entry.path}" is reserved (matches "${reservedBy}"). ` +
            'Change it in a separate reserved run with its own approval.',
        });
        return;
      }
      entries.push({ entry: parsed.entry, ownsIndex });
    });

    if (task.mode === 'readonly' && task.owns.length > 0) {
      errors.push({ path: `tasks[${index}].owns`, code: 'owns-mode', message: 'A readonly task must not own files.' });
    }
    if (task.mode === 'write' && task.owns.length === 0) {
      errors.push({ path: `tasks[${index}].owns`, code: 'owns-mode', message: 'A write task must own at least one path.' });
    }
    return { index, task, entries };
  });
}

function checkReservedRun(plan: PlanInput, errors: ValidationError[]): void {
  plan.tasks.forEach((task, i) => {
    if (task.kind !== 'reserved') return;
    if (plan.tasks.length !== 1) {
      errors.push({
        path: `tasks[${i}].kind`,
        code: 'reserved-run',
        message: 'A reserved task must be the only task in its run. Plan it as a separate, earlier run.',
      });
    }
    if (task.mode !== 'write') {
      errors.push({ path: `tasks[${i}].mode`, code: 'reserved-run', message: 'A reserved task must be a write task.' });
    }
  });
}

function checkDependencies(plan: PlanInput, errors: ValidationError[]): Map<string, string[]> {
  const ids = new Set(plan.tasks.map((t) => t.id));
  const graph = new Map<string, string[]>();
  plan.tasks.forEach((task, i) => {
    const deps: string[] = [];
    const seen = new Set<string>();
    task.dependsOn.forEach((dep, j) => {
      const where = `tasks[${i}].dependsOn[${j}]`;
      if (dep === task.id) {
        errors.push({ path: where, code: 'dep-self', message: `Task "${task.id}" depends on itself.` });
      } else if (!ids.has(dep)) {
        errors.push({ path: where, code: 'dep-unknown', message: `Task "${task.id}" depends on unknown task "${dep}".` });
      } else if (seen.has(dep)) {
        errors.push({ path: where, code: 'dep-duplicate', message: `Task "${task.id}" lists "${dep}" twice.` });
      } else {
        deps.push(dep);
      }
      seen.add(dep);
    });
    if (!graph.has(task.id)) graph.set(task.id, deps);
  });
  const cycle = findCycle(graph);
  if (cycle !== null) {
    errors.push({ path: 'tasks', code: 'dep-cycle', message: `Dependency cycle: ${cycle.join(' -> ')}.` });
  }
  return graph;
}

function checkOverlap(
  parsed: readonly ParsedTask[],
  graph: Map<string, string[]>,
  ctx: ValidationContext,
  errors: ValidationError[],
): void {
  for (let later = 1; later < parsed.length; later++) {
    const b = parsed[later] as ParsedTask;
    for (const { entry: entryB, ownsIndex } of b.entries) {
      for (let earlier = 0; earlier < later; earlier++) {
        const a = parsed[earlier] as ParsedTask;
        const clash = a.entries.find(({ entry: entryA }) => entriesOverlap(entryA, entryB));
        if (clash === undefined) continue;
        const where = `tasks[${b.index}].owns[${ownsIndex}]`;
        if (ctx.overlapMode === 'strict') {
          errors.push({
            path: where,
            code: 'overlap-strict',
            message: `"${entryB.path}" overlaps "${clash.entry.path}" owned by task "${a.task.id}"; strict mode allows no overlap.`,
          });
          break;
        }
        const ordered =
          dependsTransitively(graph, b.task.id, a.task.id) || dependsTransitively(graph, a.task.id, b.task.id);
        if (!ordered) {
          errors.push({
            path: where,
            code: 'overlap-unordered',
            message:
              `"${entryB.path}" (task "${b.task.id}") overlaps "${clash.entry.path}" (task "${a.task.id}"), ` +
              'and neither task depends on the other. Add a dependsOn so they run in order, or give the files to one task.',
          });
          break;
        }
      }
    }
  }
}

function checkEngines(plan: PlanInput, ctx: ValidationContext, errors: ValidationError[]): void {
  if (ctx.readyEngines.length === 0) {
    errors.push({
      path: 'tasks',
      code: 'no-engines',
      message: 'No engine is ready. Install and sign in to Claude Code or Codex, or set up Antigravity.',
    });
    return;
  }
  const ready = new Set(ctx.readyEngines);
  let allReady = true;
  plan.tasks.forEach((task, i) => {
    if (!ready.has(task.engine)) {
      allReady = false;
      errors.push({
        path: `tasks[${i}].engine`,
        code: 'engine-not-ready',
        message: `Engine "${task.engine}" is not ready. Ready engines: ${ctx.readyEngines.join(', ')}.`,
      });
    }
  });
  if (!allReady || ctx.splitMode === 'off') return;

  const split = checkEvenSplit(
    plan.tasks.map((t) => t.engine),
    ctx.readyEngines,
  );
  if (!split.ok) {
    const counts = ctx.readyEngines.map((e) => `${e}: ${split.counts[e] ?? 0}`).join(', ');
    const target = split.min === split.max ? `${split.min} each` : `${split.min} or ${split.max} each`;
    errors.push({
      path: 'tasks',
      code: 'uneven-split',
      message: `Tasks must be split evenly across the ready engines (${target}); this plan has ${counts}.`,
    });
  }
}

function normalize(plan: PlanInput, parsed: readonly ParsedTask[]): NormalizedPlan {
  const { baseSha: _discarded, ...rest } = plan;
  return {
    ...rest,
    tasks: parsed.map(({ task, entries }) => ({
      ...task,
      owns: minimizeEntries(entries.map((e) => e.entry)).map((e) => e.path),
    })),
  };
}

export function validatePlan(input: unknown, ctx: ValidationContext): ValidationResult {
  const result = PlanSchema.safeParse(input);
  if (!result.success) return { ok: false, errors: schemaErrors(result.error) };
  const plan = result.data;

  const errors: ValidationError[] = [];
  checkIdentity(plan, ctx, errors);
  const parsed = parseTasksOwns(plan, ctx, errors);
  checkReservedRun(plan, errors);
  const graph = checkDependencies(plan, errors);
  if (!errors.some((e) => e.code === 'dep-cycle')) checkOverlap(parsed, graph, ctx, errors);
  checkEngines(plan, ctx, errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, plan: normalize(plan, parsed) };
}
