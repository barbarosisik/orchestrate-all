import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { homeLayout, orchestraHome } from '../../src/config/home.js';

describe('orchestraHome', () => {
  it('defaults to .orchestra in the user home folder', () => {
    expect(orchestraHome({})).toBe(join(homedir(), '.orchestra'));
    expect(orchestraHome({ ORCHESTRA_HOME: '' })).toBe(join(homedir(), '.orchestra'));
  });

  it('uses ORCHESTRA_HOME when set', () => {
    const custom = join(homedir(), 'custom-orchestra');
    expect(orchestraHome({ ORCHESTRA_HOME: custom })).toBe(custom);
  });

  it('refuses a relative ORCHESTRA_HOME', () => {
    expect(() => orchestraHome({ ORCHESTRA_HOME: 'relative/home' })).toThrow(/absolute/);
  });
});

describe('homeLayout', () => {
  it('keeps worktrees, run folders and the empty hooks folder directly under the home', () => {
    const home = join(homedir(), '.orchestra');
    expect(homeLayout(home)).toEqual({
      home,
      worktrees: join(home, 'wt'),
      runs: join(home, 'runs'),
      emptyHooks: join(home, 'empty-hooks'),
    });
  });
});
