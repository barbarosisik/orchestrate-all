/**
 * Fake engines for tests (step 10): small Node scripts in a temp folder, installed where Orchestra looks for
 * `claude`, `codex` and `agy`, that answer like the real CLIs from a scenario and record how they were started
 * (arguments, stdin, folder, environment). The real CLIs are never run in tests.
 *
 * - Linux and macOS: `<bin>/<name>`, a script starting with `#!/usr/bin/env node` (PATH must reach node).
 * - Windows: what npm installs, `<bin>/<name>.cmd` with the CLI's script under `node_modules` (Orchestra starts
 *   it through node), and for `agy` a `.cmd` that cmd.exe runs.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { EngineName } from '../../src/plan/schema.js';

export interface FakeReply {
  /** Lines printed on stdout (objects as JSON). */
  readonly stdout?: readonly (string | object)[];
  /** Bytes of "x" printed on one stdout line before `stdout`. */
  readonly fillerBytes?: number;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly delayMs?: number;
  /** Never exits on its own. */
  readonly hang?: boolean;
  /** Ends by sending itself this signal (Linux and macOS). */
  readonly killSelf?: string;
  /**
   * Starts a child that writes `marker` after `afterMs`, and doesn't wait for it: in the same process group, or with
   * `detached`, on its own (its own session on Linux and macOS), keeping the engine's stdout open with `holdsOutput`.
   */
  readonly leaveChild?: { readonly marker: string; readonly afterMs: number; readonly detached?: boolean; readonly holdsOutput?: boolean };
  /** Files written (or, for null, deleted) before replying, relative to the folder it runs in: a worker's edits. */
  readonly writeFiles?: Readonly<Record<string, string | null>>;
  /** Files written by absolute path before replying: a worker stepping outside its worktree. */
  readonly writeAbsolute?: Readonly<Record<string, string>>;
}

export interface FakeScenario {
  /** Replies by the exact arguments, joined with spaces: "--version", "auth status". */
  readonly replies?: Readonly<Record<string, FakeReply>>;
  /** The reply to anything else (a worker run). */
  readonly run?: FakeReply;
  /** Replies to worker runs by their brief: the first entry whose every string is in the brief wins, before `run`. */
  readonly byBrief?: readonly { readonly includes: readonly string[]; readonly reply: FakeReply }[];
}

export interface FakeCall {
  readonly argv: string[];
  readonly stdin: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  /** The value after `--settings`, if any. */
  readonly settings: string | null;
  readonly pid: number;
}

export interface FakeEngine {
  readonly bin: string;
  calls(): FakeCall[];
  setScenario(scenario: FakeScenario): void;
}

const COMMANDS: Record<EngineName, string> = { claude: 'claude', codex: 'codex', antigravity: 'agy' };
const NPM_SCRIPTS: Partial<Record<EngineName, string[]>> = {
  claude: ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js'],
  codex: ['node_modules', '@openai', 'codex', 'bin', 'codex.js'],
};

function script(scenarioFile: string, callsFile: string): string {
  return `
const fs = require('fs');
const cp = require('child_process');
const scenario = JSON.parse(fs.readFileSync(${JSON.stringify(scenarioFile)}, 'utf8'));
const argv = process.argv.slice(2);
const chunks = [];
let done = false;
function pick(stdin) {
  if (scenario.replies && Object.prototype.hasOwnProperty.call(scenario.replies, argv.join(' '))) return scenario.replies[argv.join(' ')];
  for (const entry of scenario.byBrief || []) if (entry.includes.every((s) => stdin.includes(s))) return entry.reply;
  return scenario.run || {};
}
function go() {
  if (done) return;
  done = true;
  const reply = pick(Buffer.concat(chunks).toString('utf8'));
  const path = require('path');
  for (const [rel, content] of Object.entries(reply.writeFiles || {})) {
    const full = path.join(process.cwd(), rel);
    if (content === null) fs.rmSync(full, { force: true });
    else { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content); }
  }
  for (const [full, content] of Object.entries(reply.writeAbsolute || {})) {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.appendFileSync(full, content);
  }
  const at = argv.indexOf('--settings');
  const settings = at >= 0 ? argv[at + 1] : null;
  fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ argv, stdin: Buffer.concat(chunks).toString('utf8'), cwd: process.cwd(), env: process.env, settings, pid: process.pid }) + '\\n');
  if (reply.leaveChild) {
    const leave = reply.leaveChild;
    cp.spawn(process.execPath, ['-e', 'setTimeout(() => require("fs").writeFileSync(' + JSON.stringify(leave.marker) + ', "x"), ' + leave.afterMs + ')'],
      { stdio: ['ignore', leave.holdsOutput ? 'inherit' : 'ignore', 'ignore'], detached: !!leave.detached }).unref();
  }
  setTimeout(() => {
    if (reply.fillerBytes) process.stdout.write('x'.repeat(reply.fillerBytes) + '\\n');
    for (const line of reply.stdout || []) process.stdout.write((typeof line === 'string' ? line : JSON.stringify(line)) + '\\n');
    if (reply.stderr) process.stderr.write(reply.stderr);
    if (reply.hang) { setInterval(() => {}, 1000); return; }
    if (reply.killSelf) { process.kill(process.pid, reply.killSelf); setInterval(() => {}, 1000); return; }
    process.exitCode = reply.exitCode || 0;
  }, reply.delayMs || 0);
}
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', go);
process.stdin.on('error', go);
`;
}

function writeScript(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(join(dirname(file), 'package.json'), '{"type":"commonjs"}\n');
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

/** Installs a fake `engine` in `bin`. */
export function installFakeEngine(bin: string, engine: EngineName, scenario: FakeScenario = {}): FakeEngine {
  mkdirSync(bin, { recursive: true });
  const scenarioFile = join(bin, `${engine}.scenario.json`);
  const callsFile = join(bin, `${engine}.calls.jsonl`);
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  const body = script(scenarioFile, callsFile);
  const name = COMMANDS[engine];
  if (process.platform !== 'win32') {
    writeScript(join(bin, name), `#!/usr/bin/env node\n${body}`);
  } else {
    const npmScript = NPM_SCRIPTS[engine];
    if (npmScript !== undefined) {
      writeFileSync(join(bin, `${name}.cmd`), '@echo this shim is never run\r\n');
      writeScript(join(bin, ...npmScript), body);
    } else {
      const file = join(bin, `fake-${name}.js`);
      writeScript(file, body);
      writeFileSync(join(bin, `${name}.cmd`), `@"${process.execPath}" "${file}" %*\r\n`);
    }
  }
  return {
    bin,
    calls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, 'utf8')
            .split('\n')
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as FakeCall)
        : [],
    setScenario: (next) => writeFileSync(scenarioFile, JSON.stringify(next)),
  };
}

const NODE_NAME = process.platform === 'win32' ? 'node.exe' : 'node';

/**
 * A folder holding node and nothing else, shared by every test process. Node's own folder must never be on a test's
 * PATH: npm installs global programs there (the real claude and codex among them), and tests never run those.
 */
export function nodeOnlyFolder(): string {
  const folder = join(tmpdir(), 'orch-node-only', createHash('sha256').update(process.execPath).digest('hex').slice(0, 16));
  if (existsSync(join(folder, NODE_NAME))) {
    assertNodeOnly(folder);
    return folder;
  }
  mkdirSync(dirname(folder), { recursive: true });
  const draft = mkdtempSync(`${folder}-`);
  const target = join(draft, NODE_NAME);
  try {
    symlinkSync(process.execPath, target);
  } catch {
    try {
      linkSync(process.execPath, target);
    } catch {
      copyFileSync(process.execPath, target);
    }
  }
  try {
    renameSync(draft, folder);
  } catch {
    // Another test process made it first.
    rmSync(draft, { recursive: true, force: true });
  }
  assertNodeOnly(folder);
  return folder;
}

function assertNodeOnly(folder: string): void {
  const names = readdirSync(folder);
  if (names.length !== 1 || names[0] !== NODE_NAME) throw new Error(`${folder} must hold only ${NODE_NAME}, not: ${names.join(', ')}`);
}

/** An environment whose PATH reaches the fakes in `bin` and node (never node's own folder), plus `extra`. */
export function fakeEnv(bin: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: [bin, nodeOnlyFolder()].join(delimiter) };
  // Copied under their own spelling: Windows names ignore case, and a second spelling would be a duplicate.
  const wanted = new Set(['SYSTEMROOT', 'PATHEXT', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP']);
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && wanted.has(name.toUpperCase())) env[name] = value;
  }
  return { ...env, ...extra };
}

/** Appends to a file a fake wrote, for tests that need to see a change. */
export function touch(file: string, text = 'x'): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, text);
}
