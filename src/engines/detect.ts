/**
 * Which engines are ready (step 10, R7), checked at the start of every run. The plan may only use ready
 * engines, and the even split is computed over them (defaultValidationContext).
 *
 * Ready means:
 * - Claude Code: installed, a version Orchestra runs workers on (MIN_CLAUDE_VERSION; the user can lower it in
 *   the config), and signed in with a Claude account: `claude auth status` reports `authMethod: "claude.ai"`, or
 *   "oauth_token" (a subscription token from `claude setup-token`, when the user lets CLAUDE_CODE_OAUTH_TOKEN
 *   through to workers).
 * - Codex: installed and signed in with ChatGPT: `codex login status` says "Logged in using ChatGPT".
 * - Antigravity (`agy`): installed, `GEMINI_API_KEY` set, and agy confirmed in API-key mode: `agy -p /usage`
 *   exits 2 under an API key (research §5.0) and 0 on a Google sign-in, which Google's consumer terms don't
 *   allow other apps to drive (research §3).
 *
 * Every probe is the CLI's own status command, run like a worker (env.ts: billing variables left out, so the
 * answer is what a worker will see), with a time limit, from a folder outside any project. Orchestra never
 * opens a credential file, and never repeats what a status command printed (Codex prints part of an API key).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchCommand, type CommandResult } from '../accept/run.js';
import { ENGINE_NAMES, type EngineName } from '../plan/schema.js';
import { billingVariablesSet, workerEnv } from './env.js';
import { engineLaunch, ENGINE_COMMANDS } from './programs.js';
import { ADAPTERS } from './registry.js';
import { parseObject, textOf } from './report.js';
import { atLeast, parseVersion } from './version.js';

/**
 * The oldest Claude Code workers run on. Before 2.1.101, `--setting-sources` without "user" (how workers load
 * project settings only) could delete conversation history older than 30 days (research §5.1).
 */
export const MIN_CLAUDE_VERSION = '2.1.101';
/** Fixes Windows path rules, hooks failing open, native AGENTS.md and more (research §5.1, §9 D4). */
export const RECOMMENDED_CLAUDE_VERSION = '2.1.325';
const DEFAULT_PROBE_TIMEOUT_MS = 20_000;
const PROBE_OUTPUT_BYTES = 64 * 1024;

export const ENGINE_PROBLEM_CODES = [
  'not-installed',
  'not-runnable',
  'probe-failed',
  'unknown-version',
  'too-old',
  'not-signed-in',
  'api-billing',
  'no-api-key',
  'not-api-key-mode',
  'bad-config',
] as const;
export type EngineProblemCode = (typeof ENGINE_PROBLEM_CODES)[number];

export interface EngineProblem {
  readonly code: EngineProblemCode;
  readonly message: string;
}

export interface EngineStatus {
  readonly engine: EngineName;
  readonly ready: boolean;
  /** The program found, or null. */
  readonly program: string | null;
  readonly version: string | null;
  /** Why it is not ready. */
  readonly problems: readonly EngineProblem[];
  /** Worth knowing, but not in the way. */
  readonly warnings: readonly string[];
}

export interface Detection {
  readonly engines: readonly EngineStatus[];
  /** The ready engines, in the order checked. */
  readonly ready: readonly EngineName[];
}

export interface DetectOptions {
  /** The conductor's environment; defaults to this process's. */
  readonly env?: NodeJS.ProcessEnv;
  /** More variable names passed to workers (the user's config). */
  readonly allowEnv?: readonly string[];
  /** Absolute program paths from the config, used instead of PATH. */
  readonly programs?: Partial<Record<EngineName, string>>;
  /** Where the probes run: a folder outside any project. Defaults to a new private temp folder. */
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** The oldest Claude Code accepted; defaults to MIN_CLAUDE_VERSION. */
  readonly minClaudeVersion?: string;
  /** Which engines to check; defaults to all. */
  readonly engines?: readonly EngineName[];
}

/** Billing variables that matter to each engine, for the warning. */
const BILLING_FOR: Readonly<Record<EngineName, (upper: string) => boolean>> = {
  claude: (n) => n.startsWith('ANTHROPIC_') || n.startsWith('CLAUDE_CODE_USE_'),
  codex: (n) => n.startsWith('CODEX_') || n.startsWith('OPENAI_'),
  antigravity: (n) => n.startsWith('GOOGLE_'),
};

function listText(names: readonly string[]): string {
  return names.length === 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

interface Probe {
  readonly run: (args: readonly string[]) => Promise<CommandResult>;
  readonly label: string;
  readonly command: string;
}

/** The problem with a probe that did not answer normally, or null. */
function probeProblem(probe: Probe, args: readonly string[], result: CommandResult, timeoutMs: number): EngineProblem | null {
  const line = `"${[probe.command, ...args].join(' ')}"`;
  if (result.status === 'not-started') return { code: 'not-runnable', message: `${probe.label} could not be started: ${result.error ?? 'unknown error'}` };
  if (result.status === 'timed-out') return { code: 'probe-failed', message: `${probe.label} did not answer ${line} within ${Math.round(timeoutMs / 1000)} s.` };
  return null;
}

async function claudeSignIn(probe: Probe, timeoutMs: number): Promise<EngineProblem | null> {
  const args = ['auth', 'status'];
  const result = await probe.run(args);
  const failed = probeProblem(probe, args, result, timeoutMs);
  if (failed !== null) return failed;
  const answer = parseObject(result.stdout.text.trim());
  const method = answer === null ? null : textOf(answer.authMethod);
  // A subscription either way: the sign-in, or a token from `claude setup-token` (research §5.8).
  if (method === 'claude.ai' || method === 'oauth_token') return null;
  if (method === 'none') return { code: 'not-signed-in', message: 'Claude Code is not signed in. Run "claude" and sign in with your Claude account.' };
  if (method === null) return { code: 'probe-failed', message: 'Could not read the answer of "claude auth status".' };
  return {
    code: 'api-billing',
    message: `Claude Code is set up to use an API key (${method.slice(0, 40)}). Orchestra runs Claude Code only on your Claude subscription: sign in with "claude auth login".`,
  };
}

async function codexSignIn(probe: Probe, timeoutMs: number): Promise<EngineProblem | null> {
  const args = ['login', 'status'];
  const result = await probe.run(args);
  const failed = probeProblem(probe, args, result, timeoutMs);
  if (failed !== null) return failed;
  // The answer goes to stderr; only its start is looked at, and it is never repeated (it can show part of a key).
  const lines = `${result.stderr.text}\n${result.stdout.text}`.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => l.startsWith('Logged in using ChatGPT'))) return null;
  if (lines.some((l) => l.startsWith('Not logged in'))) {
    return { code: 'not-signed-in', message: 'Codex is not signed in. Run "codex login" and sign in with ChatGPT.' };
  }
  return {
    code: 'api-billing',
    message: 'Codex is signed in another way than with ChatGPT. Orchestra runs Codex only on your ChatGPT sign-in: run "codex login" and choose ChatGPT.',
  };
}

async function antigravityKeyMode(probe: Probe, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<EngineProblem | null> {
  const key = Object.entries(env).find(([name]) => name.toUpperCase() === 'GEMINI_API_KEY')?.[1];
  if (key === undefined || key.length === 0) {
    return {
      code: 'no-api-key',
      message: 'GEMINI_API_KEY is not set. Antigravity workers run on your Gemini API key (set a spending cap in Google AI Studio).',
    };
  }
  const args = ['-p', '/usage', '--output-format', 'json'];
  const result = await probe.run(args);
  const failed = probeProblem(probe, args, result, timeoutMs);
  if (failed !== null) return failed;
  if (result.exitCode === 2) return null;
  if (result.exitCode === 0) {
    return {
      code: 'not-api-key-mode',
      message:
        'agy is using your Google sign-in, not your Gemini API key. Google does not allow other apps to drive agy on a ' +
        'subscription, so Orchestra needs API-key mode: set "modelProvider": "gemini" in agy\'s settings.',
    };
  }
  return {
    code: 'probe-failed',
    message: `Could not confirm that agy runs on your Gemini API key ("agy -p /usage" exited with code ${result.exitCode ?? 'none'}).`,
  };
}

async function detectOne(engine: EngineName, opts: DetectOptions & { readonly cwd: string }): Promise<EngineStatus> {
  const base = opts.env ?? process.env;
  const { env, refused } = workerEnv(engine, base, { allow: opts.allowEnv ?? [] });
  const cwd = opts.cwd;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const label = ADAPTERS[engine].label;
  const program = opts.programs?.[engine];
  const warnings: string[] = [];
  const billing = billingVariablesSet(base).filter((name) => BILLING_FOR[engine](name.toUpperCase()));
  if (billing.length > 0) {
    const verb = billing.length === 1 ? 'is' : 'are';
    const pronoun = billing.length === 1 ? 'it' : 'them';
    const tail = engine === 'antigravity' ? '' : ', so they run on your subscription';
    warnings.push(`${listText(billing)} ${verb} set in your environment. Orchestra does not pass ${pronoun} to ${label} workers${tail}.`);
  }
  if (refused.length > 0) warnings.push(`Not passed to workers although allowed in the config (they switch billing): ${listText(refused)}.`);

  const located = engineLaunch(engine, ['--version'], { cwd, env, ...(program !== undefined ? { program } : {}) });
  const status = (problems: EngineProblem[], found: string | null, version: string | null): EngineStatus => ({
    engine,
    ready: problems.length === 0,
    program: found,
    version,
    problems,
    warnings,
  });
  if (!located.ok) return status([{ code: 'not-installed', message: `${label} is not installed: ${located.error.message}` }], null, null);
  const found = located.launch.program;

  const probe: Probe = {
    label,
    command: ENGINE_COMMANDS[engine],
    run: async (args) => {
      const launch = engineLaunch(engine, args, { cwd, env, ...(program !== undefined ? { program } : {}) });
      if (!launch.ok) throw new Error(launch.error.message);
      return launchCommand([ENGINE_COMMANDS[engine], ...args], launch.launch, cwd, env, timeoutMs, PROBE_OUTPUT_BYTES);
    },
  };

  let versionResult: CommandResult;
  try {
    versionResult = await probe.run(['--version']);
  } catch (error) {
    return status([{ code: 'not-runnable', message: (error as Error).message }], found, null);
  }
  const versionFailed = probeProblem(probe, ['--version'], versionResult, timeoutMs);
  if (versionFailed !== null) return status([versionFailed], found, null);
  if (versionResult.exitCode !== 0) {
    return status([{ code: 'probe-failed', message: `"${ENGINE_COMMANDS[engine]} --version" failed (exit code ${versionResult.exitCode ?? 'none'}).` }], found, null);
  }
  const version = parseVersion(`${versionResult.stdout.text}\n${versionResult.stderr.text}`);

  if (engine === 'claude') {
    if (version === null) return status([{ code: 'unknown-version', message: 'Could not read the version "claude --version" printed.' }], found, null);
    const floor = opts.minClaudeVersion ?? MIN_CLAUDE_VERSION;
    if (parseVersion(floor) === null) {
      return status([{ code: 'bad-config', message: `The configured oldest Claude Code version "${floor}" is not a version (like ${MIN_CLAUDE_VERSION}).` }], found, version.text);
    }
    if (!atLeast(version, floor)) {
      return status(
        [
          {
            code: 'too-old',
            message:
              `Claude Code ${version.text} is older than ${floor}, the oldest version Orchestra runs workers on: before it, the settings ` +
              'workers start with could delete your conversation history older than 30 days. Update it with "claude update" ' +
              `(${RECOMMENDED_CLAUDE_VERSION} or later is recommended).`,
          },
        ],
        found,
        version.text,
      );
    }
    if (!atLeast(version, RECOMMENDED_CLAUDE_VERSION)) {
      warnings.push(`Claude Code ${version.text} works, but ${RECOMMENDED_CLAUDE_VERSION} or later is recommended: it fixes bugs that affect workers (research §5.1).`);
    }
  } else if (version === null) {
    warnings.push(`Could not read the version "${ENGINE_COMMANDS[engine]} --version" printed.`);
  }

  let signIn: EngineProblem | null;
  try {
    signIn =
      engine === 'claude'
        ? await claudeSignIn(probe, timeoutMs)
        : engine === 'codex'
          ? await codexSignIn(probe, timeoutMs)
          : await antigravityKeyMode(probe, env, timeoutMs);
  } catch (error) {
    signIn = { code: 'not-runnable', message: (error as Error).message };
  }
  return status(signIn === null ? [] : [signIn], found, version?.text ?? null);
}

/**
 * Checks each engine (in parallel). Never throws. By default the probes run in a new, empty, private folder, so
 * no project's (or anyone else's) settings in the current or the shared temp folder can change their answers.
 */
export async function detectEngines(opts: DetectOptions = {}): Promise<Detection> {
  let own: string | null = null;
  try {
    own = opts.cwd === undefined ? await mkdtemp(join(tmpdir(), 'orch-detect-')) : null;
    const cwd = opts.cwd ?? own ?? tmpdir();
    const engines = await Promise.all((opts.engines ?? ENGINE_NAMES).map((engine) => detectOne(engine, { ...opts, cwd })));
    return { engines, ready: engines.filter((e) => e.ready).map((e) => e.engine) };
  } finally {
    if (own !== null) await rm(own, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}
