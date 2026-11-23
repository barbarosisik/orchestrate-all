import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { engineLaunch } from '../../src/engines/programs.js';
import { ENGINE_NAMES } from '../../src/plan/schema.js';
import { canonicalPath, samePath } from '../../src/repo/canonical.js';
import { fakeEnv, nodeOnlyFolder } from './fake-engine.js';

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

describe('the test environment for engines', () => {
  it('reaches no real engine program, only what a test installs', () => {
    const bin = mkdtempSync(join(tmpdir(), 'orch-bin-'));
    scratch.push(bin);
    const env = fakeEnv(bin);
    for (const engine of ENGINE_NAMES) {
      // Resolution only: nothing is started.
      const found = engineLaunch(engine, ['--version'], { cwd: realpathSync(tmpdir()), env });
      expect(found.ok, `${engine} must not be found`).toBe(false);
    }
  });

  it("never puts node's own folder on PATH (npm installs global programs there)", () => {
    const folders = (fakeEnv(tmpdir()).PATH ?? '').split(delimiter);
    const nodeFolder = canonicalPath(dirname(process.execPath)) ?? dirname(process.execPath);
    for (const folder of folders) expect(samePath(canonicalPath(folder) ?? folder, nodeFolder, true)).toBe(false);
  });

  it('still runs node by name', () => {
    const out = execFileSync(join(nodeOnlyFolder(), process.platform === 'win32' ? 'node.exe' : 'node'), ['-e', 'process.stdout.write("ok")'], {
      encoding: 'utf8',
    });
    expect(out).toBe('ok');
  });
});
