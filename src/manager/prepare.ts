/**
 * Getting a plan ready for the user's approval (step 12, the start of HANDOFF's "How the steps fit together"):
 *
 * 1. detectEngines: which engines are ready; the plan may use only those (R7).
 * 2. validatePlan, then checkRepo: the plan's rules, then the real repository (branch, base commit, unsaved work).
 * 3. buildRulesManifest on the base commit: the project's rule files and the files they import.
 * 4. The imported files become reserved paths (one exact pattern each, plan/reserved.ts's literalPattern), and the
 *    plan is validated again with them: a task that owned one could change what later Claude workers load. The
 *    same patterns go into the scope rules for the whole run.
 * 5. The text the approval dialog shows: the routing table, the engines' problems and warnings, and the rules
 *    manifest. Text from the plan is shown with hidden characters made visible.
 */

import { DEFAULT_HOOK_POLICY, DEFAULT_RESERVED_PATTERNS, defaultValidationContext, FORBIDDEN_PATTERNS } from '../config/defaults.js';
import { detectEngines, type DetectOptions, type Detection } from '../engines/detect.js';
import { repoContext, type HookPolicy, type RepoContext } from '../git/context.js';
import { literalPattern } from '../plan/reserved.js';
import type { EngineName } from '../plan/schema.js';
import { validatePlan, type ValidationError } from '../plan/validate.js';
import { DEFAULT_CASE_INSENSITIVE } from '../repo/canonical.js';
import { checkRepo, type ReadyPlan } from '../repo/checks.js';
import { showHidden } from '../rules/hidden.js';
import { buildRulesManifest, type RulesManifest } from '../rules/manifest.js';
import { formatRulesManifest } from '../rules/report.js';
import type { ScopeRules } from '../scope/rules.js';

export interface PrepareOptions {
  /** Orchestra's home. */
  readonly home: string;
  /** The user's home folder, for the personal rule files (os.homedir() for a real run). */
  readonly userHome: string;
  /** The conductor's environment (passed to detection and the manifest, never stored). */
  readonly env: NodeJS.ProcessEnv;
  readonly programs?: Partial<Record<EngineName, string>>;
  readonly allowEnv?: readonly string[];
  readonly detect?: (opts: DetectOptions) => Promise<Detection>;
  readonly caseInsensitivePaths?: boolean;
  readonly hooks?: HookPolicy;
}

export interface PreparedRun {
  readonly ready: ReadyPlan;
  readonly ctx: RepoContext;
  readonly manifest: RulesManifest;
  readonly detection: Detection;
  /** The reserved patterns plus one exact pattern per imported file: for the brief and the scope rules. */
  readonly scopeRules: ScopeRules;
}

export interface PlanProblem {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type PrepareResult = { readonly ok: true; readonly prepared: PreparedRun } | { readonly ok: false; readonly problems: readonly PlanProblem[] };

function problems(errors: readonly ValidationError[]): PrepareResult {
  return { ok: false, problems: errors.map((e) => ({ code: e.code, path: e.path, message: e.message })) };
}

function one(code: string, message: string): PrepareResult {
  return { ok: false, problems: [{ code, path: '', message }] };
}

/** The scope rules for a run: the reserved patterns, plus every file the base commit's rule files import, exactly. */
export function scopeRulesFor(manifest: RulesManifest): { ok: true; rules: ScopeRules } | { ok: false; message: string } {
  const exact: string[] = [];
  for (const file of manifest.imported) {
    const pattern = literalPattern(file.path);
    if (pattern === null) {
      return { ok: false, message: `A rule file imports "${showHidden(file.path)}", a name Orchestra can't reserve exactly. Rename it before running.` };
    }
    exact.push(pattern);
  }
  return { ok: true, rules: { reservedPatterns: [...DEFAULT_RESERVED_PATTERNS, ...exact], forbiddenPatterns: FORBIDDEN_PATTERNS } };
}

/** Checks a plan everywhere it can be checked before approval. Never throws. */
export async function prepareRun(input: unknown, opts: PrepareOptions): Promise<PrepareResult> {
  try {
    const detection = await (opts.detect ?? detectEngines)({
      env: opts.env,
      ...(opts.programs !== undefined ? { programs: opts.programs } : {}),
      ...(opts.allowEnv !== undefined ? { allowEnv: opts.allowEnv } : {}),
    });
    const base = defaultValidationContext(detection.ready);
    const first = validatePlan(input, base);
    if (!first.ok) return problems(first.errors);
    const caseInsensitivePaths = opts.caseInsensitivePaths ?? DEFAULT_CASE_INSENSITIVE;
    const repo = await checkRepo(first.plan, { caseInsensitivePaths });
    if (!repo.ok) return problems(repo.errors);
    const ready = repo.ready;
    const ctx = repoContext(ready, { home: opts.home, hooks: opts.hooks ?? DEFAULT_HOOK_POLICY, caseInsensitivePaths });
    const built = await buildRulesManifest(ctx, { baseSha: ready.plan.baseSha, home: opts.userHome, env: opts.env });
    if (!built.ok) return one('rules-manifest', built.problem);
    const scope = scopeRulesFor(built.manifest);
    if (!scope.ok) return one('rules-manifest', scope.message);
    const second = validatePlan(input, { ...base, reservedPatterns: scope.rules.reservedPatterns });
    if (!second.ok) return problems(second.errors);
    return { ok: true, prepared: { ready, ctx, manifest: built.manifest, detection, scopeRules: scope.rules } };
  } catch (error) {
    return one('prepare-failed', `The plan could not be checked: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function clipped(text: string, max: number): string {
  const shown = showHidden(text.replace(/[\r\n]+/g, ' '));
  return shown.length > max ? `${shown.slice(0, max)}…` : shown;
}

/** What the user reads before approving the start: the routing table, the engines and the rules manifest. */
export function startApprovalText(runId: string, prepared: PreparedRun): string {
  const { ready, manifest, detection } = prepared;
  const plan = ready.plan;
  const lines = [
    `Start Orchestra run ${runId}?`,
    `Repository: ${ready.repoRoot}`,
    `Your branch: ${clipped(plan.targetBranch, 200)} at ${plan.baseSha.slice(0, 12)} (nothing reaches it until you approve the finalize)`,
    `Plan: ${ready.planHash}`,
    `Goal: ${clipped(plan.goal, 2000)}`,
    '',
    'Tasks:',
  ];
  for (const task of plan.tasks) {
    const after = task.dependsOn.length > 0 ? `, after ${task.dependsOn.join(', ')}` : '';
    const owns = task.owns.length > 0 ? task.owns.map((o) => clipped(o, 200)).join(', ') : 'nothing (read-only)';
    lines.push(`- ${task.id}: ${clipped(task.title, 200)} [${task.engine}, ${task.model}${after}]${task.kind === 'reserved' ? ' (reserved files)' : ''}`);
    lines.push(`  may change: ${clipped(owns, 2000)}`);
    if (task.acceptance.commands.length > 0) lines.push(`  checks: ${clipped(task.acceptance.commands.map((c) => c.join(' ')).join('; '), 2000)}`);
  }
  lines.push('', 'Engines:');
  for (const engine of detection.engines) {
    const state = engine.ready ? `ready${engine.version === null ? '' : ` (${engine.version})`}` : `not ready: ${engine.problems.map((p) => p.message).join(' ')}`;
    lines.push(`- ${engine.engine}: ${state}`, ...engine.warnings.map((w) => `  ! ${w}`));
  }
  lines.push('', formatRulesManifest(manifest));
  return lines.join('\n');
}
