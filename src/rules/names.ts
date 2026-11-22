/**
 * Which files in a repository are agent rule files (step 11, research §4.2), and for which engine.
 *
 * Families:
 * - `shared`: `AGENTS.md`, the cross-engine standard. Codex and Antigravity read it; Claude Code only from
 *   2.1.277, and only where no CLAUDE.md is in charge.
 * - `codex`: `AGENTS.override.md`. Only Codex reads it, and in its folder it reads it instead of `AGENTS.md`.
 * - `claude`: `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` and `.claude/rules/**.md`. Only Claude Code.
 * - `gemini`: `GEMINI.md`, `.agents/AGENTS.md`, `.agents/GEMINI.md` and `.agents/rules/*.md` (legacy
 *   `.agent/rules/`). Only Antigravity (and the Gemini CLI).
 *
 * A rule file covers a folder: the one it sits in, or for `.claude/...` and `.agents/...` the one holding that
 * folder. Names are matched ignoring letter case (Windows and macOS find `Agents.md` when asked for
 * `AGENTS.md`; Linux doesn't), and `nameCase` says when the stored name differs from the one engines ask for.
 */

export const RULE_FAMILIES = ['shared', 'codex', 'claude', 'gemini'] as const;
export type RuleFamily = (typeof RULE_FAMILIES)[number];

export const RULE_KINDS = [
  'AGENTS.md',
  'AGENTS.override.md',
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  'CLAUDE.local.md',
  '.claude/rules',
  'GEMINI.md',
  '.agents/AGENTS.md',
  '.agents/GEMINI.md',
  '.agents/rules',
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export interface RuleName {
  readonly kind: RuleKind;
  readonly family: RuleFamily;
  /** The folder the file covers, repo-relative with "/" ('' for the top of the repository), as stored. */
  readonly folder: string;
  /** The stored name differs in letter case from the name engines look for. */
  readonly nameCase: boolean;
}

/** Plain file names, by their lower-case form. */
const PLAIN: Readonly<Record<string, { kind: RuleKind; family: RuleFamily }>> = {
  'agents.md': { kind: 'AGENTS.md', family: 'shared' },
  'agents.override.md': { kind: 'AGENTS.override.md', family: 'codex' },
  'claude.md': { kind: 'CLAUDE.md', family: 'claude' },
  'claude.local.md': { kind: 'CLAUDE.local.md', family: 'claude' },
  'gemini.md': { kind: 'GEMINI.md', family: 'gemini' },
};

/** Kinds that are a file's own name: the name engines look for. */
const KIND_NAME: Readonly<Partial<Record<RuleKind, string>>> = {
  'AGENTS.md': 'AGENTS.md',
  'AGENTS.override.md': 'AGENTS.override.md',
  'CLAUDE.md': 'CLAUDE.md',
  'CLAUDE.local.md': 'CLAUDE.local.md',
  'GEMINI.md': 'GEMINI.md',
  '.claude/CLAUDE.md': 'CLAUDE.md',
  '.agents/AGENTS.md': 'AGENTS.md',
  '.agents/GEMINI.md': 'GEMINI.md',
};

function folderOf(segments: readonly string[], end: number): string {
  return segments.slice(0, end).join('/');
}

function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith('.md') && name.length > 3;
}

/** What kind of rule file `path` (repo-relative, "/" separators) is, or null for any other file. */
export function classifyRulePath(path: string): RuleName | null {
  const segments = path.split('/');
  const lower = segments.map((s) => s.toLowerCase());
  const n = segments.length;
  const last = lower[n - 1] ?? '';

  // .claude/rules/**/*.md (any depth below rules/)
  for (let i = 0; i + 2 < n; i++) {
    if (lower[i] === '.claude' && lower[i + 1] === 'rules') {
      if (!isMarkdown(last)) break;
      const nameCase = segments[i] !== '.claude' || segments[i + 1] !== 'rules';
      return { kind: '.claude/rules', family: 'claude', folder: folderOf(segments, i), nameCase };
    }
  }
  // .claude/CLAUDE.md
  if (n >= 2 && lower[n - 2] === '.claude' && last === 'claude.md') {
    return { kind: '.claude/CLAUDE.md', family: 'claude', folder: folderOf(segments, n - 2), nameCase: segments[n - 2] !== '.claude' || segments[n - 1] !== 'CLAUDE.md' };
  }
  // .agents/rules/*.md and the legacy .agent/rules/*.md (one level)
  if (n >= 3 && (lower[n - 3] === '.agents' || lower[n - 3] === '.agent') && lower[n - 2] === 'rules' && isMarkdown(last)) {
    const nameCase = (segments[n - 3] !== '.agents' && segments[n - 3] !== '.agent') || segments[n - 2] !== 'rules';
    return { kind: '.agents/rules', family: 'gemini', folder: folderOf(segments, n - 3), nameCase };
  }
  // .agents/AGENTS.md and .agents/GEMINI.md
  if (n >= 2 && lower[n - 2] === '.agents' && (last === 'agents.md' || last === 'gemini.md')) {
    const kind: RuleKind = last === 'agents.md' ? '.agents/AGENTS.md' : '.agents/GEMINI.md';
    return { kind, family: 'gemini', folder: folderOf(segments, n - 2), nameCase: segments[n - 2] !== '.agents' || segments[n - 1] !== KIND_NAME[kind] };
  }
  const plain = PLAIN[last];
  if (plain === undefined) return null;
  return { ...plain, folder: folderOf(segments, n - 1), nameCase: segments[n - 1] !== KIND_NAME[plain.kind] };
}

/** Kinds that hold a folder's main Claude rules: Claude reads them instead of AGENTS.md. */
export const CLAUDE_MAIN_KINDS: ReadonlySet<RuleKind> = new Set(['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']);

/** Git pathspecs (glob, case ignored) matching every rule file, for `git status`. */
export function ruleNamePathspecs(): string[] {
  return ['**/AGENTS.md', '**/AGENTS.override.md', '**/CLAUDE.md', '**/CLAUDE.local.md', '**/.claude/rules/**/*.md', '**/GEMINI.md', '**/.agents/rules/*.md', '**/.agent/rules/*.md'].map(
    (glob) => `:(glob,icase)${glob}`,
  );
}
