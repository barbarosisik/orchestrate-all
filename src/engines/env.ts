/**
 * The environment a worker (and each detection probe) runs with (step 10).
 *
 * A worker is the user's own CLI on the user's own sign-in, so it needs what the CLI needs to find itself and
 * that sign-in: the acceptance allowlist (PATH, home and profile folders, temp, locale, toolchains; see
 * accept/env.ts), the session bus Linux keyrings answer on, and the folder each CLI keeps its settings in
 * when the user moved it (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Everything else stays out: tokens, npm and
 * proxy settings (a proxy URL can hold a password; the user can allow it), and every GIT_* variable (they can
 * point git at another repository).
 *
 * Billing variables are never passed, even when the user allows them (R3: Claude and Codex run on the user's
 * subscriptions). Each would quietly move a worker to API billing or another provider: Anthropic's API key,
 * auth token, base URL and profile and the Bedrock/Vertex/Foundry switches; Codex's API key and access token
 * and OpenAI's key and base URL; Google's other keys, Vertex and cloud credentials. The one exception is
 * deliberate: Antigravity workers get `GEMINI_API_KEY`, the Google lane the owner chose (research §3). Orchestra
 * passes variables through to the CLI and never reads or keeps their values.
 *
 * Claude workers also get two settings of their own: no automatic memory (a worker must not write the user's
 * personal memory or read another run's) and no claude.ai connectors (the plan's "no MCP servers").
 */

import { DEFAULT_COMMAND_ENV, DEFAULT_COMMAND_ENV_PREFIXES } from '../accept/env.js';
import type { EngineName } from '../plan/schema.js';

/** Passed to every worker when set: Linux keyrings (Codex, agy) are reached through the session bus. */
const COMMON_WORKER_ENV = ['DBUS_SESSION_BUS_ADDRESS'];

/** Passed to one engine only, when set. */
const ENGINE_ENV: Readonly<Record<EngineName, readonly string[]>> = {
  claude: ['CLAUDE_CONFIG_DIR'],
  codex: ['CODEX_HOME', 'CODEX_SQLITE_HOME'],
  antigravity: ['GEMINI_API_KEY'],
};

/** Set for one engine. */
const ENGINE_SETTINGS: Readonly<Record<EngineName, Readonly<Record<string, string>>>> = {
  claude: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
  codex: {},
  antigravity: {},
};

const BILLING_NAMES = new Set([
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GEMINI_API_KEY',
]);
const BILLING_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_USE_', 'GOOGLE_CLOUD_', 'GOOGLE_GENAI_'];

/** A variable that switches some engine to API billing or another provider (upper-case name). */
function isBilling(upper: string): boolean {
  return BILLING_NAMES.has(upper) || BILLING_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export interface WorkerEnvOptions {
  /** More variable names to pass (from the user's config), such as HTTPS_PROXY. */
  readonly allow?: readonly string[];
}

export interface WorkerEnv {
  readonly env: NodeJS.ProcessEnv;
  /** Names in `allow` that were refused because they would switch billing. */
  readonly refused: readonly string[];
}

export function workerEnv(engine: EngineName, base: NodeJS.ProcessEnv = process.env, opts: WorkerEnvOptions = {}): WorkerEnv {
  const own = new Set(ENGINE_ENV[engine].map((name) => name.toUpperCase()));
  const refused = (opts.allow ?? []).filter((name) => isBilling(name.toUpperCase()) && !own.has(name.toUpperCase()));
  const allowed = new Set([...DEFAULT_COMMAND_ENV, ...COMMON_WORKER_ENV, ...(opts.allow ?? [])].map((name) => name.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase();
    if (value === undefined || upper.startsWith('GIT_')) continue;
    if (own.has(upper)) {
      env[key] = value;
      continue;
    }
    if (isBilling(upper)) continue;
    if (allowed.has(upper) || DEFAULT_COMMAND_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) env[key] = value;
  }
  Object.assign(env, ENGINE_SETTINGS[engine]);
  return { env, refused };
}

/** Names of the billing variables set (non-empty) in `base`, for a warning. Values are never looked at beyond that. */
export function billingVariablesSet(base: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(base)
    .filter(([key, value]) => value !== undefined && value.length > 0 && key.toUpperCase() !== 'GEMINI_API_KEY' && isBilling(key.toUpperCase()))
    .map(([key]) => key)
    .sort();
}
