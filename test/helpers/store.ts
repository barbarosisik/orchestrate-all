/** Sample plans, records and review states for run store tests. Pure data: no repository needed. */

import { sha256Of } from '../../src/plan/hash.js';
import type { ReadyPlan } from '../../src/repo/checks.js';
import { newTaskReview, recordGate, recordReview, startRevision, type TaskReview } from '../../src/review/state.js';
import type { PlanRecord } from '../../src/store/schema.js';
import { newPlanRecord } from '../../src/store/state.js';

export const BASE = 'b'.repeat(40);
export const SHA = (char: string): string => char.repeat(40);
export const NOW = new Date('2026-11-21T12:00:00.000Z');

export interface SampleTask {
  readonly id: string;
  readonly dependsOn?: string[];
  readonly criteria?: string[];
  readonly commands?: string[][];
  readonly owns?: string[];
}

export function samplePlan(tasks: readonly SampleTask[], baseSha = BASE, repo = '/repo'): ReadyPlan['plan'] {
  return {
    version: 1,
    goal: 'Sample goal',
    repo,
    targetBranch: 'main',
    orchestrator: { engine: 'claude', model: 'opus' },
    tasks: tasks.map((t) => ({
      id: t.id,
      title: `Task ${t.id}`,
      kind: 'work',
      mode: 'write',
      brief: `Do ${t.id}.`,
      engine: 'claude',
      model: 'test-model',
      owns: t.owns ?? [`src/${t.id}/`],
      dependsOn: t.dependsOn ?? [],
      acceptance: { commands: t.commands ?? [], criteria: t.criteria ?? ['works'] },
    })),
    baseSha,
  };
}

export function sampleReady(tasks: readonly SampleTask[], baseSha = BASE): ReadyPlan {
  const plan = samplePlan(tasks, baseSha);
  return { plan, planHash: sha256Of(plan), repoRoot: '/repo', gitCommonDir: '/repo/.git' };
}

export function sampleRecord(runId: string, tasks: readonly SampleTask[], baseSha = BASE): PlanRecord {
  return newPlanRecord({ runId, ready: sampleReady(tasks, baseSha), hooks: 'off', caseInsensitivePaths: true }, NOW);
}

function must<T>(step: { ok: true; state: T } | { ok: false; error: { message: string } }): T {
  if (!step.ok) throw new Error(step.error.message);
  return step.state;
}

export function passingReview(criteria: readonly string[], verdict: 'accept' | 'revise' | 'reject' = 'accept'): unknown {
  return {
    verdict,
    criteria: criteria.map((criterion) => ({ criterion, verdict: 'pass', evidence: 'seen in the diff' })),
    findings: [],
    ...(verdict === 'revise' ? { instructions: 'Tidy up.' } : {}),
  };
}

/** A review state whose gate passed, waiting for the reviewer. */
export function awaitingReview(taskId: string, criteria: readonly string[] = ['works']): TaskReview {
  return must(recordGate(newTaskReview({ id: taskId, acceptance: { criteria } }, { maxRevisionRounds: 2 }), { passed: true, summary: 'ok' }));
}

/** A review state accepted through the real transitions, optionally after one revision. */
export function acceptedReview(taskId: string, criteria: readonly string[] = ['works'], revised = false): TaskReview {
  let state = newTaskReview({ id: taskId, acceptance: { criteria } }, { maxRevisionRounds: 2 });
  if (revised) {
    state = must(recordGate(state, { passed: false, summary: '0/1 commands passed' }));
    state = must(recordReview(state, passingReview(criteria, 'revise')));
    state = must(startRevision(state));
  }
  state = must(recordGate(state, { passed: true, summary: '1/1 commands passed; integrity ok' }));
  return must(recordReview(state, passingReview(criteria)));
}
