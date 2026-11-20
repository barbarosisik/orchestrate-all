import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultGlobalGitFiles,
  gitConfigFiles,
  parseConfigOrigins,
  resolveConfigPath,
} from '../../src/integrity/config-files.js';
import { fixtures } from '../helpers/fixture.js';

const f = fixtures();
afterEach(() => f.cleanupAll());

describe('defaultGlobalGitFiles', () => {
  it('watches ~/.gitconfig and the XDG config and attributes files', () => {
    const config = join(homedir(), '.config', 'git');
    expect(defaultGlobalGitFiles({})).toEqual([
      join(homedir(), '.gitconfig'),
      join(config, 'config'),
      join(config, 'attributes'),
    ]);
    const xdg = join(homedir(), 'xdg');
    expect(defaultGlobalGitFiles({ XDG_CONFIG_HOME: xdg })[1]).toBe(join(xdg, 'git', 'config'));
    expect(defaultGlobalGitFiles({ XDG_CONFIG_HOME: 'relative' })[1]).toBe(join(config, 'config'));
  });
});

describe('resolveConfigPath', () => {
  it('expands "~/", keeps absolute paths and resolves relative ones', () => {
    const base = resolve('/base/dir');
    expect(resolveConfigPath('~/x.inc', base)).toBe(join(homedir(), 'x.inc'));
    expect(resolveConfigPath('~', base)).toBe(homedir());
    expect(resolveConfigPath(resolve('/abs/x.inc'), base)).toBe(resolve('/abs/x.inc'));
    expect(resolveConfigPath('../x.inc', base)).toBe(resolve(base, '../x.inc'));
  });

  it("skips what it can't resolve", () => {
    expect(resolveConfigPath('', '/base')).toBeNull();
    expect(resolveConfigPath('~someone/x', '/base')).toBeNull();
    expect(resolveConfigPath('%(prefix)/etc/x', '/base')).toBeNull();
  });
});

describe('parseConfigOrigins', () => {
  it('lists the files git read and the files their settings name', () => {
    const cwd = resolve('/repo/.git');
    const root = resolve('/repo');
    const output = [
      'file:/etc/gitconfig',
      'core.pager\nless',
      'command line:',
      'core.fsmonitor\nfalse',
      'file:config',
      'include.path\n../extra.inc',
      'file:/home/u/.gitconfig',
      'includeIf.gitdir:~/work/.path\n~/.work.inc',
      'file:/home/u/.gitconfig',
      'core.attributesFile\n.attrs',
      'file:/home/u/.gitconfig',
      'core.bare',
      '',
    ].join('\u0000');
    expect(parseConfigOrigins(output, cwd, root)).toEqual([
      resolve(cwd, '/etc/gitconfig'),
      resolve(cwd, 'config'),
      resolve('/repo/.git', '../extra.inc'),
      resolve('/home/u/.gitconfig'),
      join(homedir(), '.work.inc'),
      resolve('/home/u/.gitconfig'),
      resolve(root, '.attrs'),
      resolve('/home/u/.gitconfig'),
    ]);
  });
});

describe('gitConfigFiles', () => {
  it("finds included files, keeps the extra ones, and leaves out the repository's own config", async () => {
    const fx = f.make();
    const included = join(fx.home, 'extra.gitconfig');
    writeFileSync(included, '[user]\n\tname = Me\n');
    fx.repo.git('config', 'include.path', included);
    fx.repo.git('config', 'includeIf.gitdir:/nowhere/.path', join(fx.home, 'never-read.gitconfig'));
    const extra = join(fx.home, 'fake-global');
    const result = await gitConfigFiles(fx.ctx, [extra, extra]);
    if (!result.ok) throw new Error(result.message);
    expect(result.files).toContain(resolve(included));
    expect(result.files).toContain(resolve(join(fx.home, 'never-read.gitconfig')));
    expect(result.files.filter((file) => file === resolve(extra))).toHaveLength(1);
    expect(result.files).not.toContain(resolve(join(fx.ctx.commonDir, 'config')));
    expect([...result.files].sort()).toEqual(result.files);
  });

  it("reports a config file git can't read", async () => {
    const fx = f.make();
    writeFileSync(join(fx.ctx.commonDir, 'config'), '[[[ not config\n');
    const result = await gitConfigFiles(fx.ctx, []);
    expect(result.ok ? 'ok' : result.message).toMatch(/git config --list failed/);
  });
});
