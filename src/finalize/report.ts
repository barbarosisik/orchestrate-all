/**
 * The finalize report as plain text: what the user is about to approve, in a few short sections. Long lists
 * are cut, with the number left out shown.
 */

import type { CommandResult } from '../accept/run.js';
import type { TreeChange } from '../scope/diff.js';
import type { FinalizeReport } from './check.js';

const MAX_FILES = 40;
const MAX_LINES = 8;

function short(id: string): string {
  return id.slice(0, 12);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function capped(lines: readonly string[], max: number): string[] {
  return lines.length > max ? [...lines.slice(0, max), `  ... and ${lines.length - max} more`] : [...lines];
}

function fileLines(changes: readonly TreeChange[]): string[] {
  return capped(
    changes.map((c) => `  ${c.status} ${c.path}`),
    MAX_FILES,
  );
}

function commandText(result: CommandResult): string {
  const what = result.argv.join(' ');
  if (result.status === 'passed') return `${what}: passed`;
  if (result.status === 'timed-out') return `${what}: stopped after the time limit`;
  if (result.status === 'not-started') return `${what}: did not start (${result.error ?? 'unknown reason'})`;
  return `${what}: failed (exit code ${result.exitCode ?? result.signal ?? '?'})`;
}

export function formatFinalizeReport(report: FinalizeReport): string {
  const lines: string[] = [];
  const verdict = report.ready ? 'ready to approve' : `not ready (${plural(report.problems.length, 'problem')})`;
  lines.push(`Finalize check, run ${report.runId} into ${report.targetBranch}: ${verdict}.`, '');

  const target = report.target;
  if (target !== null) {
    lines.push(
      target.moved
        ? `Your branch ${target.branch} has ${plural(target.newCommits, 'new commit')} since the run started (now at ${short(target.tip)}); the run's work merges into it cleanly.`
        : `Your branch ${target.branch} is where the run started (${short(target.tip)}).`,
    );
    if (report.checkouts.length > 0) lines.push(`Checked out in ${report.checkouts.join(', ')}: its files will be updated.`);
    lines.push('');
  }

  lines.push(`Tasks (${report.tasks.length}):`);
  for (const task of report.tasks) {
    const merged = task.mergeCommit === null ? 'no changes' : `merged as ${short(task.mergeCommit)}, ${plural(task.changes.length, 'file')}`;
    const tests = task.acceptance === null ? '' : task.acceptance.passed ? ', tests passed' : ', tests FAILED';
    lines.push(`  ${task.id}: ${task.title} (${task.engine}, ${task.model}), ${merged}${tests}`);
  }
  lines.push('');

  if (target !== null) {
    lines.push(`Files your branch would get (${target.changes.length}):`, ...fileLines(target.changes), '');
  }

  const acceptance = report.acceptance;
  if (acceptance !== null && acceptance.gate !== null) {
    lines.push(`Acceptance on the combined result: ${acceptance.gate.summary}.`);
    lines.push(...capped(acceptance.gate.acceptance.commands.map((c) => `  ${commandText(c)}`), MAX_LINES), '');
  }

  if (report.problems.length > 0) {
    lines.push('Problems:', ...capped(report.problems.map((p) => `  - ${p.message}`), MAX_LINES), '');
  }
  if (report.notes.length > 0) {
    lines.push('Notes:', ...capped(report.notes.map((n) => `  - ${n}`), MAX_LINES), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
