import { describe, expect, it } from 'vitest';
import {
  branchRef,
  isValidRunId,
  isValidTaskId,
  MAX_RUN_ID_LENGTH,
  newRunId,
  ORCHESTRA_REF_PREFIX,
  taskBranch,
} from '../../src/run/names.js';

describe('newRunId', () => {
  it('uses the UTC start time and four random characters', () => {
    const id = newRunId(new Date(Date.UTC(2026, 10, 20, 15, 2, 3)), Uint8Array.from([0, 1, 26, 35]));
    expect(id).toBe('20261120-150203-ab09');
  });

  it('makes valid ids that sort by start time', () => {
    const earlier = newRunId(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)));
    const later = newRunId(new Date(Date.UTC(2026, 0, 2, 3, 4, 6)));
    expect(isValidRunId(earlier)).toBe(true);
    expect(earlier < later).toBe(true);
  });

  it('differs between runs started in the same second', () => {
    const now = new Date();
    const ids = new Set(Array.from({ length: 20 }, () => newRunId(now)));
    expect(ids.size).toBeGreaterThan(1);
  });
});

describe('isValidRunId', () => {
  it('accepts short lower-case names with single dashes', () => {
    expect(isValidRunId('run1')).toBe(true);
    expect(isValidRunId('20261120-150203-k3x9')).toBe(true);
  });

  it('rejects anything that could misbehave as a folder or branch name', () => {
    for (const bad of ['', 'Run1', 'a/b', 'a..b', '-a', 'a-', 'a--b', 'a.b', 'a b', 'con', 'nul', 'x'.repeat(MAX_RUN_ID_LENGTH + 1)]) {
      expect(isValidRunId(bad), bad).toBe(false);
    }
  });
});

describe('isValidTaskId', () => {
  it('follows the plan rules', () => {
    expect(isValidTaskId('api')).toBe(true);
    expect(isValidTaskId('integration')).toBe(false);
    expect(isValidTaskId('aux')).toBe(false);
    expect(isValidTaskId('API')).toBe(false);
  });
});

describe('branch names', () => {
  it('puts every task branch under orchestra/', () => {
    expect(taskBranch('run1', 'api')).toBe('orchestra/run1/api');
    expect(branchRef(taskBranch('run1', 'api'))).toBe('refs/heads/orchestra/run1/api');
    expect(branchRef(taskBranch('run1', 'api')).startsWith(ORCHESTRA_REF_PREFIX)).toBe(true);
  });
});
