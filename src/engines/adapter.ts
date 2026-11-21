/**
 * The shape every engine adapter has (step 10): how to start the engine's CLI for one worker run, and how to
 * read what it prints. An adapter is pure: it builds arguments and parses lines. Starting the process, the
 * environment (env.ts), finding the program (programs.ts), time limits and saving the output are the
 * worker runner's job (worker.ts), the same for every engine.
 *
 * What every adapter does, as research §5 recommends:
 * - the brief goes on stdin, never on the command line (no length limit, nothing for a shell or a list
 *   option to misread, research §5.1);
 * - the engine prints a JSON event stream, so the conductor sees tokens, refusals and the final result;
 * - the engine may edit files only within its worktree, in the engine's own way (its edit mode or sandbox);
 *   commits are the conductor's (step 5), so a worker never needs to write `.git`;
 * - the user's project rules still load (each CLI's native rule files), and nothing outside the project
 *   that the user didn't choose for workers: no MCP servers, no hooks (PLAN §4).
 *
 * Which tools a worker may use beyond editing its worktree is the owner's choice. For now, the PLAN §4 default
 * holds: Claude workers have no shell unless the run allows it (`shell`). Codex always has its shell, inside
 * its sandbox; Antigravity asks for commands, which a headless run refuses unless the user's own settings
 * allow them.
 */

import { MODEL_PATTERN, type EngineName } from '../plan/schema.js';
import type { EngineParser } from './report.js';

export interface WorkerRequest {
  /** The model from the approved plan. */
  readonly model: string;
  /** The task's worktree (absolute), where the worker runs. */
  readonly worktree: string;
  /** The worker's brief (step 11 writes it). */
  readonly brief: string;
  /** Whether Claude workers keep their shell tools (PLAN §4 default: no). */
  readonly shell: boolean;
}

export interface EngineLaunch {
  /** Arguments after the program. */
  readonly args: readonly string[];
  /** What to write to the engine's stdin, which is then closed. */
  readonly stdin: string;
}

export interface EngineAdapter {
  readonly engine: EngineName;
  /** The display name used in messages. */
  readonly label: string;
  /**
   * How to start one worker run. Nothing is written to disk for it: a settings file in a shared folder could be
   * rewritten by another engine's sandboxed worker (Codex may write the temp folder) before the engine reads it.
   */
  launch(request: WorkerRequest): EngineLaunch;
  parser(request: WorkerRequest): EngineParser;
}

/** A model name as the plan schema allows it; anything else is a bug in the caller (it could read as a flag). */
export function checkedModel(model: string): string {
  if (!MODEL_PATTERN.test(model) || model.startsWith('-')) throw new Error(`"${model}" is not a model name the plan allows.`);
  return model;
}
