import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Tests pass their own Orchestra home; this keeps any test that forgets out of the real ~/.orchestra.
    env: { ORCHESTRA_HOME: join(tmpdir(), 'orchestra-test-home') },
    // Integration tests start many short git processes, which is slow on Windows runners.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
