/**
 * Orchestra's data folder (ORCHESTRA_HOME). Everything Orchestra writes lives here, outside the user's
 * repository: task worktrees and run folders. Paths stay short because Windows limits path length.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const ORCHESTRA_HOME_ENV = 'ORCHESTRA_HOME';

/** $ORCHESTRA_HOME if set, otherwise ".orchestra" in the user's home folder (%USERPROFILE% on Windows). */
export function orchestraHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[ORCHESTRA_HOME_ENV];
  if (fromEnv === undefined || fromEnv.length === 0) return join(homedir(), '.orchestra');
  if (!isAbsolute(fromEnv)) throw new Error(`${ORCHESTRA_HOME_ENV} must be an absolute path, not "${fromEnv}".`);
  return fromEnv;
}

export interface HomeLayout {
  readonly home: string;
  /** Task worktrees: `<home>/wt/<runId>/<taskId>`. */
  readonly worktrees: string;
  /** Run folders: `<home>/runs/<runId>`, everything a run records (store/). */
  readonly runs: string;
  /** An always-empty folder. Pointing core.hooksPath here stops repository hooks from running. */
  readonly emptyHooks: string;
}

export function homeLayout(home: string): HomeLayout {
  return { home, worktrees: join(home, 'wt'), runs: join(home, 'runs'), emptyHooks: join(home, 'empty-hooks') };
}
