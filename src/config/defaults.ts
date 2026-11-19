/** Default configuration. Every value here can be overridden in config.json. */

import type { EngineName } from '../plan/schema.js';
import type { ValidationContext } from '../plan/validate.js';

/**
 * Paths only a separate "reserved" run (one task, its own approval) may change.
 * Patterns follow the rules in plan/reserved.ts.
 */
export const DEFAULT_RESERVED_PATTERNS: readonly string[] = [
  // Dependency manifests and lockfiles
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '*.lock',
  'bun.lockb',
  'pyproject.toml',
  'requirements*.txt',
  'Pipfile',
  'Cargo.toml',
  'go.mod',
  'go.sum',
  'Gemfile',
  'composer.json',
  // Root and build config
  'tsconfig*.json',
  // Git and CI
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.github/',
  '.gitlab-ci.yml',
  '.husky/',
  // Secrets and environment
  '.env*',
  '.envrc',
  '.npmrc',
  '.yarnrc*',
  // Agent and editor configuration (executable in practice: hooks, MCP servers, tasks)
  '.claude/',
  '.mcp.json',
  '.codex/',
  '.agents/',
  '.gemini/',
  '.cursor/',
  '.vscode/',
  '.idea/',
  '.worktreeinclude',
  // Agent instruction files: an edit here changes every later agent session
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'AGENTS.override.md',
  'GEMINI.md',
  // Orchestra's own files
  '.orchestra*',
];

/** Paths no task may ever own, not even a reserved task. */
export const FORBIDDEN_PATTERNS: readonly string[] = ['.git'];

export const DEFAULT_LIMITS = {
  maxTasks: 8,
  maxParallelWorkers: 3,
  taskTimeoutMinutes: 30,
} as const;

export function defaultValidationContext(readyEngines: readonly EngineName[]): ValidationContext {
  return {
    readyEngines,
    reservedPatterns: DEFAULT_RESERVED_PATTERNS,
    forbiddenPatterns: FORBIDDEN_PATTERNS,
    maxTasks: DEFAULT_LIMITS.maxTasks,
    overlapMode: 'ordered',
    splitMode: 'even',
  };
}
