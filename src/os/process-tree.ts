/**
 * Stopping a process and everything it started (steps 6 and 10).
 *
 * - Linux and macOS: the process is started in its own process group (`detached: true`), and the whole group
 *   is killed. A process that left the group (started its own) is not reached.
 * - Windows: `taskkill /t /f` stops the process and its children. A child whose parent already exited is no
 *   longer in the tree and is not reached; a Job Object would stop it too (not built yet, see
 *   docs/HANDOFF.md).
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

/** The longest delay a timer takes: Node runs a longer one (or NaN, Infinity) after 1 ms instead. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** A time limit usable with setTimeout: `ms` when it is a positive number (at most MAX_TIMER_MS), else `fallback`. */
export function timerDelay(ms: number | undefined, fallback: number): number {
  return ms !== undefined && Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_TIMER_MS) : fallback;
}

/** Whether a child should be started in its own process group, so stopTree can reach its whole tree. */
export const OWN_PROCESS_GROUP = process.platform !== 'win32';

/** Stops process `pid` and everything it started. Never throws; resolves once the stop was attempted. */
export async function stopTree(pid: number, env: NodeJS.ProcessEnv): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group is already gone.
    }
    return;
  }
  const systemRoot = Object.entries(env).find(([k]) => k.toUpperCase() === 'SYSTEMROOT')?.[1] ?? process.env.SystemRoot;
  if (systemRoot === undefined) return;
  await new Promise<void>((done) => {
    const killer = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/pid', String(pid), '/t', '/f'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => done());
    killer.on('close', () => done());
  });
}
