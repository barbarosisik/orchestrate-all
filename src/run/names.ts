/**
 * Names Orchestra gives to runs, branches and worktree folders. A run id and a task id end up in a branch
 * name (`orchestra/<runId>/<taskId>`) and in a folder path (`<home>/wt/<runId>/<taskId>`), so both use only
 * a-z, 0-9 and "-", stay short, and avoid names Windows reserves.
 */

import { randomBytes } from 'node:crypto';
import { isWindowsDeviceName } from '../plan/paths.js';
import { TASK_ID_PATTERN } from '../plan/schema.js';
import { RESERVED_TASK_IDS } from '../plan/validate.js';

export const BRANCH_NAMESPACE = 'orchestra';
export const MAX_RUN_ID_LENGTH = 32;
const RUN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function isValidRunId(id: string): boolean {
  return id.length <= MAX_RUN_ID_LENGTH && RUN_ID_PATTERN.test(id) && !isWindowsDeviceName(id);
}

/** The same rule the plan validator applies to task ids. */
export function isValidTaskId(id: string): boolean {
  return TASK_ID_PATTERN.test(id) && !RESERVED_TASK_IDS.has(id) && !isWindowsDeviceName(id);
}

/**
 * A new run id: the UTC start time plus four random characters, for example "20261120-150203-k3x9".
 * Run ids sort by start time.
 */
export function newRunId(now: Date = new Date(), random: Uint8Array = randomBytes(4)): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  const date = `${now.getUTCFullYear()}${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}`;
  const time = `${two(now.getUTCHours())}${two(now.getUTCMinutes())}${two(now.getUTCSeconds())}`;
  const suffix = Array.from(random.subarray(0, 4), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
  return `${date}-${time}-${suffix}`;
}

/** The branch a task works on: `orchestra/<runId>/<taskId>`. */
export function taskBranch(runId: string, taskId: string): string {
  return `${BRANCH_NAMESPACE}/${runId}/${taskId}`;
}

export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

/** Every ref Orchestra creates lives under this prefix. */
export const ORCHESTRA_REF_PREFIX = `refs/heads/${BRANCH_NAMESPACE}/`;
