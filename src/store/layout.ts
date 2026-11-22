/**
 * The run folder's layout (step 9). Everything a run records lives outside the user's repository:
 *
 *   <home>/runs/<runId>/
 *     plan.json            the approved plan, its hash and where the repository is (written once)
 *     state.json           the run's state: what a restarted conductor needs to carry on (replaced atomically)
 *     finalize.json        the last finalize report
 *     log.jsonl            the conductor's decisions, one JSON record per line
 *     tasks/<taskId>/
 *       worker-<round>.out  the worker's raw output (stdout), capped
 *       worker-<round>.err  the worker's error output (stderr), capped
 *       gate-<round>.json   the gate: each acceptance command with its output, integrity and scope results
 *       diff-<round>.patch  the diff of the task's commit, capped
 *       brief-<round>.md    the brief the worker was given (step 11), saved before it starts
 *
 * `<round>` is the review round (0 for the first attempt, then one per revision). Every name comes from a
 * validated run id, task id or round number, so none can contain "..", a separator, upper case or a name
 * Windows reserves. Names stay short: Windows limits path length.
 *
 * Every folder from `<home>/runs` down must be a real folder, never a link (as `<home>/wt`); writes check the
 * whole chain each time. The home folder itself may be a link: that is the user's choice.
 */

import { join } from 'node:path';
import { homeLayout } from '../config/home.js';
import { canonicalPath } from '../repo/canonical.js';
import { isValidRunId, isValidTaskId } from '../run/names.js';
import { folderProblem, type FileProblem } from './files.js';

export const RUN_FILES = { plan: 'plan.json', state: 'state.json', finalize: 'finalize.json', log: 'log.jsonl' } as const;
export const TASKS_FOLDER = 'tasks';
/** Rounds are review rounds; the default allows 2 revisions. 99 keeps file names short. */
export const MAX_ROUND = 99;

export const OUTPUT_STREAMS = ['stdout', 'stderr'] as const;
export type OutputStream = (typeof OUTPUT_STREAMS)[number];
export type RoundFile = OutputStream | 'gate' | 'diff' | 'brief';

/** Checked at run time too: names may come from outside (the front doors, step 14). */
export function isOutputStream(value: unknown): value is OutputStream {
  return (OUTPUT_STREAMS as readonly unknown[]).includes(value);
}

const ROUND_FILE: Record<RoundFile, (round: number) => string> = {
  stdout: (round) => `worker-${round}.out`,
  stderr: (round) => `worker-${round}.err`,
  gate: (round) => `gate-${round}.json`,
  diff: (round) => `diff-${round}.patch`,
  brief: (round) => `brief-${round}.md`,
};

export function isValidRound(round: number): boolean {
  return Number.isInteger(round) && round >= 0 && round <= MAX_ROUND;
}

/** `<home>/runs`, with the home's own links resolved when it exists. */
export function runsFolder(home: string): string {
  return homeLayout(canonicalPath(home) ?? home).runs;
}

export interface RunPaths {
  readonly runs: string;
  readonly folder: string;
  readonly plan: string;
  readonly state: string;
  readonly finalize: string;
  readonly log: string;
  readonly tasks: string;
}

/** The run's paths. Only for a valid run id: callers check first. */
export function runPaths(home: string, runId: string): RunPaths {
  if (!isValidRunId(runId)) throw new Error(`"${runId}" is not a valid run id.`);
  const runs = runsFolder(home);
  const folder = join(runs, runId);
  return {
    runs,
    folder,
    plan: join(folder, RUN_FILES.plan),
    state: join(folder, RUN_FILES.state),
    finalize: join(folder, RUN_FILES.finalize),
    log: join(folder, RUN_FILES.log),
    tasks: join(folder, TASKS_FOLDER),
  };
}

export function taskFolder(paths: RunPaths, taskId: string): string {
  if (!isValidTaskId(taskId)) throw new Error(`"${taskId}" is not a valid task id.`);
  return join(paths.tasks, taskId);
}

export function roundFile(paths: RunPaths, taskId: string, kind: RoundFile, round: number): string {
  if (!isValidRound(round)) throw new Error(`${round} is not a valid round.`);
  if (!Object.hasOwn(ROUND_FILE, kind)) throw new Error(`"${String(kind)}" is not a kind of round file.`);
  return join(taskFolder(paths, taskId), ROUND_FILE[kind](round));
}

/** The first folder in the list that is not a real folder, in order, or null when all are. */
export async function firstFolderProblem(folders: readonly string[]): Promise<FileProblem | null> {
  for (const folder of folders) {
    const problem = await folderProblem(folder);
    if (problem !== null) return problem;
  }
  return null;
}
