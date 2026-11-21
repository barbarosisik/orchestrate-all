import { describe, expect, it } from 'vitest';
import { atLeast, compareVersions, parseVersion } from '../../src/engines/version.js';

describe('parseVersion', () => {
  it("reads each engine's --version line", () => {
    expect(parseVersion('2.1.97 (Claude Code)\n')).toMatchObject({ major: 2, minor: 1, patch: 97, pre: null, text: '2.1.97' });
    expect(parseVersion('codex-cli 0.170.0')).toMatchObject({ major: 0, minor: 170, patch: 0, text: '0.170.0' });
    expect(parseVersion('codex-cli 0.169.0-alpha.11.1')).toMatchObject({ pre: 'alpha.11.1', text: '0.169.0-alpha.11.1' });
    expect(parseVersion('agy version v1.5.12 (build abc)')).toMatchObject({ major: 1, minor: 5, patch: 12 });
  });

  it('gives null when there is no version', () => {
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('Claude Code')).toBeNull();
    expect(parseVersion('2.1')).toBeNull();
  });

  it('refuses numbers too large to compare safely', () => {
    expect(parseVersion('99999999999999999999.1.1')).toBeNull();
  });

  it('takes the first version in the text', () => {
    expect(parseVersion('2.1.300 (built with node 22.1.0)')?.text).toBe('2.1.300');
  });
});

describe('compareVersions and atLeast', () => {
  const v = (text: string) => {
    const parsed = parseVersion(text);
    if (parsed === null) throw new Error(text);
    return parsed;
  };

  it('compares major, minor and patch as numbers', () => {
    expect(compareVersions(v('2.1.97'), v('2.1.101'))).toBeLessThan(0);
    expect(compareVersions(v('2.10.0'), v('2.9.9'))).toBeGreaterThan(0);
    expect(compareVersions(v('3.0.0'), v('2.99.99'))).toBeGreaterThan(0);
    expect(compareVersions(v('2.1.101'), v('2.1.101'))).toBe(0);
  });

  it('orders pre-release parts as semver does: numbers by value, numbers before words, longer after', () => {
    expect(compareVersions(v('2.1.101-beta.10'), v('2.1.101-beta.2'))).toBeGreaterThan(0);
    expect(compareVersions(v('1.0.0-alpha.1'), v('1.0.0-alpha.beta'))).toBeLessThan(0);
    expect(compareVersions(v('1.0.0-alpha'), v('1.0.0-alpha.1'))).toBeLessThan(0);
    expect(compareVersions(v('1.0.0-beta'), v('1.0.0-alpha'))).toBeGreaterThan(0);
    expect(compareVersions(v('1.0.0-rc.99999999999999999999'), v('1.0.0-rc.99999999999999999998'))).toBeGreaterThan(0);
  });

  it('puts a pre-release before its release', () => {
    expect(compareVersions(v('0.169.0-alpha.11.1'), v('0.169.0'))).toBeLessThan(0);
    expect(compareVersions(v('0.169.0'), v('0.169.0-alpha.11.1'))).toBeGreaterThan(0);
    expect(compareVersions(v('0.169.0-alpha.1'), v('0.169.0-alpha.1'))).toBe(0);
  });

  it('atLeast checks a minimum', () => {
    expect(atLeast(v('2.1.97'), '2.1.101')).toBe(false);
    expect(atLeast(v('2.1.101'), '2.1.101')).toBe(true);
    expect(atLeast(v('2.1.325'), '2.1.101')).toBe(true);
    expect(() => atLeast(v('2.1.0'), 'not a version')).toThrow();
  });
});
