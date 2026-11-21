import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectEngines, MIN_CLAUDE_VERSION, RECOMMENDED_CLAUDE_VERSION, type DetectOptions } from '../../src/engines/detect.js';
import { fakeEnv, installFakeEngine, type FakeScenario } from '../helpers/fake-engine.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempBin(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orch-detect-')));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  return bin;
}

const CLAUDE_READY: FakeScenario = {
  replies: {
    '--version': { stdout: ['2.1.330 (Claude Code)'] },
    'auth status': { stdout: [{ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }] },
  },
};
const CODEX_READY: FakeScenario = {
  replies: { '--version': { stdout: ['codex-cli 0.170.0'] }, 'login status': { stderr: 'Logged in using ChatGPT\n' } },
};
const AGY_READY: FakeScenario = {
  replies: { '--version': { stdout: ['1.5.12'] }, '-p /usage --output-format json': { stdout: [{ error: 'quota commands need a sign-in' }], exitCode: 2 } },
};

function detect(bin: string, extra: NodeJS.ProcessEnv = {}, opts: Partial<DetectOptions> = {}) {
  return detectEngines({ env: fakeEnv(bin, extra), cwd: realpathSync(tmpdir()), ...opts });
}

function status(detection: Awaited<ReturnType<typeof detectEngines>>, engine: string) {
  const found = detection.engines.find((e) => e.engine === engine);
  if (found === undefined) throw new Error(engine);
  return found;
}

describe('detectEngines', () => {
  it('finds every engine ready: installed, a known version, signed in or on the API key', async () => {
    const bin = tempBin();
    installFakeEngine(bin, 'claude', CLAUDE_READY);
    installFakeEngine(bin, 'codex', CODEX_READY);
    installFakeEngine(bin, 'antigravity', AGY_READY);
    const detection = await detect(bin, { GEMINI_API_KEY: 'AIza-key' });
    expect(detection.ready).toEqual(['claude', 'codex', 'antigravity']);
    expect(status(detection, 'claude')).toMatchObject({ ready: true, version: '2.1.330', problems: [], warnings: [] });
    expect(status(detection, 'codex')).toMatchObject({ ready: true, version: '0.170.0', problems: [] });
    expect(status(detection, 'antigravity')).toMatchObject({ ready: true, version: '1.5.12', problems: [] });
    expect(status(detection, 'claude').program).not.toBeNull();
  });

  it('checks only the engines asked for', async () => {
    const bin = tempBin();
    installFakeEngine(bin, 'codex', CODEX_READY);
    const detection = await detect(bin, {}, { engines: ['codex'] });
    expect(detection.engines.map((e) => e.engine)).toEqual(['codex']);
    expect(detection.ready).toEqual(['codex']);
  });

  it('reports an engine that is not installed', async () => {
    const detection = await detect(tempBin(), {}, { engines: ['claude', 'codex', 'antigravity'] });
    expect(detection.ready).toEqual([]);
    for (const engine of detection.engines) {
      expect(engine.problems.map((p) => p.code)).toEqual(['not-installed']);
      expect(engine.program).toBeNull();
    }
  });

  it('runs every probe with the worker environment: billing variables never reach the CLI', async () => {
    const bin = tempBin();
    const claude = installFakeEngine(bin, 'claude', CLAUDE_READY);
    const detection = await detect(bin, { ANTHROPIC_API_KEY: 'sk-ant', CLAUDE_CODE_USE_BEDROCK: '1' }, { engines: ['claude'] });
    for (const call of claude.calls()) {
      expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(call.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    }
    expect(claude.calls().map((c) => c.argv.join(' '))).toEqual(['--version', 'auth status']);
    expect(status(detection, 'claude').ready).toBe(true);
    expect(status(detection, 'claude').warnings).toEqual([
      'ANTHROPIC_API_KEY and CLAUDE_CODE_USE_BEDROCK are set in your environment. Orchestra does not pass them to Claude Code workers, so they run on your subscription.',
    ]);
  });
});

describe('detectEngines: Claude Code', () => {
  it(`refuses a version older than ${MIN_CLAUDE_VERSION}, and says why and what to do`, async () => {
    const bin = tempBin();
    const fake = installFakeEngine(bin, 'claude', { replies: { ...CLAUDE_READY.replies, '--version': { stdout: ['2.1.97 (Claude Code)'] } } });
    const s = status(await detect(bin, {}, { engines: ['claude'] }), 'claude');
    expect(s.ready).toBe(false);
    expect(s.version).toBe('2.1.97');
    expect(s.problems).toEqual([
      {
        code: 'too-old',
        message:
          `Claude Code 2.1.97 is older than ${MIN_CLAUDE_VERSION}, the oldest version Orchestra runs workers on: before it, the settings ` +
          'workers start with could delete your conversation history older than 30 days. Update it with "claude update" ' +
          `(${RECOMMENDED_CLAUDE_VERSION} or later is recommended).`,
      },
    ]);
    // An engine too old is not asked anything more.
    expect(fake.calls().map((c) => c.argv.join(' '))).toEqual(['--version']);
  });

  it('accepts an older floor from the config, and still recommends upgrading', async () => {
    const bin = tempBin();
    installFakeEngine(bin, 'claude', { replies: { ...CLAUDE_READY.replies, '--version': { stdout: ['2.1.97 (Claude Code)'] } } });
    const s = status(await detect(bin, {}, { engines: ['claude'], minClaudeVersion: '2.1.0' }), 'claude');
    expect(s.ready).toBe(true);
    expect(s.warnings).toEqual([
      `Claude Code 2.1.97 works, but ${RECOMMENDED_CLAUDE_VERSION} or later is recommended: it fixes bugs that affect workers (research §5.1).`,
    ]);
  });

  it('reports a configured oldest version that is not a version, without throwing', async () => {
    const bin = tempBin();
    installFakeEngine(bin, 'claude', CLAUDE_READY);
    const s = status(await detect(bin, {}, { engines: ['claude'], minClaudeVersion: 'latest' }), 'claude');
    expect(s.problems).toEqual([{ code: 'bad-config', message: `The configured oldest Claude Code version "latest" is not a version (like ${MIN_CLAUDE_VERSION}).` }]);
  });

  it('runs its probes in a new private folder by default, and removes it', async () => {
    const bin = tempBin();
    const fake = installFakeEngine(bin, 'claude', CLAUDE_READY);
    const detection = await detectEngines({ env: fakeEnv(bin), engines: ['claude'] });
    expect(status(detection, 'claude').ready).toBe(true);
    const cwd = fake.calls()[0]?.cwd ?? '';
    expect(cwd).toContain('orch-detect-');
    expect(fake.calls().every((c) => c.cwd === cwd)).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  });

  it('refuses a version it cannot read', async () => {
    const bin = tempBin();
    installFakeEngine(bin, 'claude', { replies: { ...CLAUDE_READY.replies, '--version': { stdout: ['Claude Code'] } } });
    const s = status(await detect(bin, {}, { engines: ['claude'] }), 'claude');
    expect(s.problems.map((p) => p.code)).toEqual(['unknown-version']);
  });

  it.each([
    [{ loggedIn: false, authMethod: 'none' }, 'not-signed-in', 'Claude Code is not signed in. Run "claude" and sign in with your Claude account.'],
    [{ loggedIn: true, authMethod: 'api_key' }, 'api-billing', 'Claude Code is set up to use an API key (api_key). Orchestra runs Claude Code only on your Claude subscription: sign in with "claude auth login".'],
    [{ loggedIn: true, authMethod: 'api_key_helper' }, 'api-billing', 'Claude Code is set up to use an API key (api_key_helper). Orchestra runs Claude Code only on your Claude subscription: sign in with "claude auth login".'],
    [{ loggedIn: true, authMethod: 'third_party' }, 'api-billing', 'Claude Code is set up to use an API key (third_party). Orchestra runs Claude Code only on your Claude subscription: sign in with "claude auth login".'],
  ])('reads `claude auth status` %j as %s', async (answer, code, message) => {
    const bin = tempBin();
    installFakeEngine(bin, 'claude', { replies: { ...CLAUDE_READY.replies, 'auth status': { stdout: [answer], exitCode: answer.loggedIn ? 0 : 1 } } });
    const s = status(await detect(bin, {}, { engines: ['claude'] }), 'claude');
    expect(s.ready).toBe(false);
    expect(s.problems).toEqual([{ code, message }]);
  });

  it('accepts a subscription token from `claude setup-token` (authMethod "oauth_token")', async () => {
    const bin = tempBin();
    installFakeEngine(bin, 'claude', { replies: { ...CLAUDE_READY.replies, 'auth status': { stdout: [{ loggedIn: true, authMethod: 'oauth_token' }] } } });
    const s = status(await detect(bin, { CLAUDE_CODE_OAUTH_TOKEN: 'x' }, { engines: ['claude'], allowEnv: ['CLAUDE_CODE_OAUTH_TOKEN'] }), 'claude');
    expect(s.ready).toBe(true);
  });

  it('reports an answer it cannot read', async () => {
    const bin = tempBin();
    installFakeEngine(bin, 'claude', { replies: { ...CLAUDE_READY.replies, 'auth status': { stdout: ['Logged in'] } } });
    const s = status(await detect(bin, {}, { engines: ['claude'] }), 'claude');
    expect(s.problems.map((p) => p.code)).toEqual(['probe-failed']);
  });

  it('reports a CLI that does not answer in time', async () => {
    const bin = tempBin();
    installFakeEngine(bin, 'claude', { replies: { '--version': { hang: true } } });
    const s = status(await detect(bin, {}, { engines: ['claude'], timeoutMs: 1000 }), 'claude');
    expect(s.problems).toEqual([{ code: 'probe-failed', message: 'Claude Code did not answer "claude --version" within 1 s.' }]);
  });

  it('reports a --version that fails', async () => {
    const bin = tempBin();
    installFakeEngine(bin, 'claude', { replies: { '--version': { exitCode: 4, stderr: 'boom' } } });
    const s = status(await detect(bin, {}, { engines: ['claude'] }), 'claude');
    expect(s.problems).toEqual([{ code: 'probe-failed', message: '"claude --version" failed (exit code 4).' }]);
  });
});

describe('detectEngines: Codex', () => {
  it.each([
    ['Not logged in\n', 'not-signed-in', 'Codex is not signed in. Run "codex login" and sign in with ChatGPT.'],
    ['API key configured - sk-...abcd\n', 'api-billing', 'Codex is signed in another way than with ChatGPT. Orchestra runs Codex only on your ChatGPT sign-in: run "codex login" and choose ChatGPT.'],
    ['Logged in using access token\n', 'api-billing', 'Codex is signed in another way than with ChatGPT. Orchestra runs Codex only on your ChatGPT sign-in: run "codex login" and choose ChatGPT.'],
  ])('reads `codex login status` %j as %s, never repeating what it printed', async (answer, code, message) => {
    const bin = tempBin();
    installFakeEngine(bin, 'codex', { replies: { ...CODEX_READY.replies, 'login status': { stderr: answer, exitCode: answer.startsWith('Not') ? 1 : 0 } } });
    const s = status(await detect(bin, {}, { engines: ['codex'] }), 'codex');
    expect(s.ready).toBe(false);
    expect(s.problems).toEqual([{ code, message }]);
    expect(JSON.stringify(s)).not.toContain('sk-');
  });

  it('accepts the ChatGPT sign-in printed on stdout too', async () => {
    const bin = tempBin();
    installFakeEngine(bin, 'codex', { replies: { ...CODEX_READY.replies, 'login status': { stdout: ['Logged in using ChatGPT'] } } });
    expect(status(await detect(bin, {}, { engines: ['codex'] }), 'codex').ready).toBe(true);
  });

  it('warns, but goes on, when it cannot read the version', async () => {
    const bin = tempBin();
    installFakeEngine(bin, 'codex', { replies: { ...CODEX_READY.replies, '--version': { stdout: ['codex-cli dev build'] } } });
    const s = status(await detect(bin, {}, { engines: ['codex'] }), 'codex');
    expect(s.ready).toBe(true);
    expect(s.version).toBeNull();
    expect(s.warnings).toEqual(['Could not read the version "codex --version" printed.']);
  });

  it('warns about Codex billing variables that are set', async () => {
    const bin = tempBin();
    installFakeEngine(bin, 'codex', CODEX_READY);
    const s = status(await detect(bin, { CODEX_API_KEY: 'sk' }, { engines: ['codex'] }), 'codex');
    expect(s.ready).toBe(true);
    expect(s.warnings).toEqual(['CODEX_API_KEY is set in your environment. Orchestra does not pass it to Codex workers, so they run on your subscription.']);
  });
});

describe('detectEngines: Antigravity', () => {
  it('needs GEMINI_API_KEY (the chosen Google lane) and does not start agy without it', async () => {
    const bin = tempBin();
    const fake = installFakeEngine(bin, 'antigravity', AGY_READY);
    const s = status(await detect(bin, {}, { engines: ['antigravity'] }), 'antigravity');
    expect(s.ready).toBe(false);
    expect(s.problems).toEqual([
      {
        code: 'no-api-key',
        message: 'GEMINI_API_KEY is not set. Antigravity workers run on your Gemini API key (set a spending cap in Google AI Studio).',
      },
    ]);
    expect(fake.calls().map((c) => c.argv.join(' '))).toEqual(['--version']);
  });

  it('refuses agy when it runs on your Google sign-in instead of the API key', async () => {
    const bin = tempBin();
    installFakeEngine(bin, 'antigravity', { replies: { ...AGY_READY.replies, '-p /usage --output-format json': { stdout: [{ quota: {} }], exitCode: 0 } } });
    const s = status(await detect(bin, { GEMINI_API_KEY: 'AIza' }, { engines: ['antigravity'] }), 'antigravity');
    expect(s.ready).toBe(false);
    expect(s.problems).toEqual([
      {
        code: 'not-api-key-mode',
        message:
          'agy is using your Google sign-in, not your Gemini API key. Google does not allow other apps to drive agy on a ' +
          'subscription, so Orchestra needs API-key mode: set "modelProvider": "gemini" in agy\'s settings.',
      },
    ]);
  });

  it('refuses agy when API-key mode cannot be confirmed', async () => {
    const bin = tempBin();
    installFakeEngine(bin, 'antigravity', { replies: { ...AGY_READY.replies, '-p /usage --output-format json': { exitCode: 3 } } });
    const s = status(await detect(bin, { GEMINI_API_KEY: 'AIza' }, { engines: ['antigravity'] }), 'antigravity');
    expect(s.problems).toEqual([{ code: 'probe-failed', message: 'Could not confirm that agy runs on your Gemini API key ("agy -p /usage" exited with code 3).' }]);
  });

  it('passes the key to agy and warns about other Google variables', async () => {
    const bin = tempBin();
    const fake = installFakeEngine(bin, 'antigravity', AGY_READY);
    const s = status(await detect(bin, { GEMINI_API_KEY: 'AIza', GOOGLE_API_KEY: 'x' }, { engines: ['antigravity'] }), 'antigravity');
    expect(s.ready).toBe(true);
    expect(fake.calls().at(-1)?.env.GEMINI_API_KEY).toBe('AIza');
    expect(fake.calls().at(-1)?.env.GOOGLE_API_KEY).toBeUndefined();
    expect(s.warnings).toEqual(['GOOGLE_API_KEY is set in your environment. Orchestra does not pass it to Antigravity workers.']);
  });
});
