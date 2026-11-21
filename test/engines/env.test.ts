import { describe, expect, it } from 'vitest';
import { billingVariablesSet, workerEnv } from '../../src/engines/env.js';

const BASE: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  HOME: '/home/u',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'C',
  XDG_RUNTIME_DIR: '/run/user/1',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus',
  TMPDIR: '/tmp',
  GIT_DIR: '/elsewhere/.git',
  GIT_CONFIG_GLOBAL: '/elsewhere/config',
  NPM_TOKEN: 'secret',
  GITHUB_TOKEN: 'secret',
  HTTPS_PROXY: 'http://user:pass@proxy:8080',
  ANTHROPIC_API_KEY: 'sk-ant',
  ANTHROPIC_AUTH_TOKEN: 'tok',
  ANTHROPIC_BASE_URL: 'http://evil',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  CLAUDE_CONFIG_DIR: '/home/u/.claude-alt',
  CODEX_API_KEY: 'sk-codex',
  CODEX_ACCESS_TOKEN: 'tok',
  CODEX_HOME: '/home/u/.codex-alt',
  OPENAI_API_KEY: 'sk-openai',
  OPENAI_BASE_URL: 'http://evil',
  GEMINI_API_KEY: 'AIza-key',
  GOOGLE_API_KEY: 'AIza-other',
  GOOGLE_GENAI_USE_VERTEXAI: 'true',
  GOOGLE_CLOUD_PROJECT: 'p',
  GOOGLE_APPLICATION_CREDENTIALS: '/home/u/creds.json',
  CI: 'false',
};

describe('workerEnv', () => {
  it('passes what programs need to find themselves, and nothing secret', () => {
    const { env } = workerEnv('claude', BASE);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.LC_ALL).toBe('C');
    expect(env.XDG_RUNTIME_DIR).toBe('/run/user/1');
    expect(env.TMPDIR).toBe('/tmp');
    // Linux keyrings (where Codex and agy may keep their sign-in) are reached through the session bus.
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1/bus');
    for (const name of ['GIT_DIR', 'GIT_CONFIG_GLOBAL', 'NPM_TOKEN', 'GITHUB_TOKEN', 'HTTPS_PROXY', 'CI']) {
      expect(env[name], name).toBeUndefined();
    }
  });

  it('never passes a variable that switches billing to an API key or another provider', () => {
    for (const engine of ['claude', 'codex', 'antigravity'] as const) {
      const { env } = workerEnv(engine, BASE);
      for (const name of [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_VERTEX',
        'CODEX_API_KEY',
        'CODEX_ACCESS_TOKEN',
        'OPENAI_API_KEY',
        'OPENAI_BASE_URL',
        'GOOGLE_API_KEY',
        'GOOGLE_GENAI_USE_VERTEXAI',
        'GOOGLE_CLOUD_PROJECT',
        'GOOGLE_APPLICATION_CREDENTIALS',
      ]) {
        expect(env[name], `${engine} ${name}`).toBeUndefined();
      }
    }
  });

  it('passes the Gemini API key to Antigravity workers only (the chosen Google lane)', () => {
    expect(workerEnv('antigravity', BASE).env.GEMINI_API_KEY).toBe('AIza-key');
    expect(workerEnv('claude', BASE).env.GEMINI_API_KEY).toBeUndefined();
    expect(workerEnv('codex', BASE).env.GEMINI_API_KEY).toBeUndefined();
  });

  it("passes where each CLI keeps its settings and sign-in, only to that CLI", () => {
    expect(workerEnv('claude', BASE).env.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude-alt');
    expect(workerEnv('codex', BASE).env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(workerEnv('codex', BASE).env.CODEX_HOME).toBe('/home/u/.codex-alt');
    expect(workerEnv('claude', BASE).env.CODEX_HOME).toBeUndefined();
  });

  it("turns off Claude's automatic memory and claude.ai connectors in Claude workers", () => {
    const { env } = workerEnv('claude', BASE);
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(workerEnv('codex', BASE).env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
  });

  it('passes extra variables the user allows, but refuses billing variables even then', () => {
    const { env, refused } = workerEnv('claude', BASE, { allow: ['HTTPS_PROXY', 'anthropic_api_key', 'CODEX_API_KEY', 'GIT_DIR'] });
    expect(env.HTTPS_PROXY).toBe('http://user:pass@proxy:8080');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
    expect(refused).toEqual(['anthropic_api_key', 'CODEX_API_KEY']);
  });

  it('compares names ignoring case, as Windows does', () => {
    const { env } = workerEnv('claude', { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', anthropic_api_key: 'sk', UserProfile: 'C:\\Users\\u' });
    expect(env.Path).toBe('C:\\Windows');
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.UserProfile).toBe('C:\\Users\\u');
    expect(env.anthropic_api_key).toBeUndefined();
  });

  it("leaves out variables whose value is missing", () => {
    expect('HOME' in workerEnv('claude', { HOME: undefined }).env).toBe(false);
  });
});

describe('billingVariablesSet', () => {
  it('names the billing variables set in an environment, never their values', () => {
    const names = billingVariablesSet(BASE);
    expect(names).toContain('ANTHROPIC_API_KEY');
    expect(names).toContain('CODEX_API_KEY');
    expect(names).toContain('GOOGLE_API_KEY');
    expect(names).not.toContain('GEMINI_API_KEY');
    expect(names.join(' ')).not.toContain('sk-');
  });

  it('ignores empty values', () => {
    expect(billingVariablesSet({ ANTHROPIC_API_KEY: '', PATH: '/bin' })).toEqual([]);
  });
});
