import { describe, expect, it } from 'vitest';
import { commandEnv, DEFAULT_COMMAND_ENV } from '../../src/accept/env.js';

describe('commandEnv', () => {
  const base: NodeJS.ProcessEnv = {
    PATH: '/bin',
    HOME: '/home/me',
    Path: 'C:\\Windows',
    SystemRoot: 'C:\\Windows',
    LC_ALL: 'C',
    XDG_CACHE_HOME: '/cache',
    JAVA_HOME: '/jdk',
    OPENAI_API_KEY: 'sk-secret',
    ANTHROPIC_API_KEY: 'secret',
    GITHUB_TOKEN: 'ghp_secret',
    npm_config__authToken: 'secret',
    AWS_SECRET_ACCESS_KEY: 'secret',
    GIT_DIR: '/evil',
    MY_TOOL_SETTING: 'x',
  };

  it('keeps what toolchains need and drops secrets and git variables', () => {
    const env = commandEnv(base);
    expect(env).toMatchObject({
      PATH: '/bin',
      HOME: '/home/me',
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      LC_ALL: 'C',
      XDG_CACHE_HOME: '/cache',
      JAVA_HOME: '/jdk',
    });
    for (const name of [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GITHUB_TOKEN',
      'npm_config__authToken',
      'AWS_SECRET_ACCESS_KEY',
      'GIT_DIR',
      'MY_TOOL_SETTING',
    ]) {
      expect(env[name], name).toBeUndefined();
    }
  });

  it('stops watch modes and colors', () => {
    expect(commandEnv({})).toEqual({ CI: 'true', NO_COLOR: '1' });
  });

  it('passes extra names the user allows, but never git variables', () => {
    const env = commandEnv(base, { allow: ['my_tool_setting', 'GIT_DIR'] });
    expect(env.MY_TOOL_SETTING).toBe('x');
    expect(env.GIT_DIR).toBeUndefined();
  });

  it('lists only names a toolchain needs', () => {
    for (const name of DEFAULT_COMMAND_ENV) expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD/);
  });
});
