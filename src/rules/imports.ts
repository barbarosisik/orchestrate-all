/**
 * Claude Code's `@path` imports in CLAUDE.md files (step 11, research/04 §2.1). Claude follows them itself; Codex
 * and Antigravity don't, so a worker on those engines is pointed at the imported files when it is pointed at the
 * CLAUDE.md that imports them.
 *
 * As Claude reads them: `@` at the start of a line or after a space, then a path relative to the file holding
 * it, `~/...` or absolute; not inside code blocks or code spans. Words like `@alice` (no "/" or ".") are not taken
 * for paths. Paths are resolved inside the repository only; anything that leaves it is "external".
 */

export interface RuleImport {
  /** The path as written after "@". */
  readonly raw: string;
  /** The repo-relative path it names, or null when it is outside the repository. */
  readonly path: string | null;
  readonly external: boolean;
}

// Every scan here is linear: rule files come from the repository, and a crafted line must not make a
// backtracking regular expression run for minutes while the conductor waits.
const IMPORT = /(?:^|[\s(])@([^\s]+)/g;
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', "'", '"']);
const FENCE = /^\s{0,3}(```|~~~)/;
const ABSOLUTE = /^(?:[\\/]|[A-Za-z]:)/;
/** Longer tokens are not taken for paths. */
const MAX_IMPORT_CHARS = 1000;

/**
 * A path relative to `folder` (repo-relative, '' for the top), as a repo-relative path with "/" separators, or
 * null when it is absolute, leaves the repository, or names the top itself.
 */
export function resolveRepoPath(folder: string, relative: string): string | null {
  if (ABSOLUTE.test(relative)) return null;
  const parts = folder.length === 0 ? [] : folder.split('/');
  for (const segment of relative.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.length === 0 ? null : parts.join('/');
}

function folderOfFile(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function looksLikePath(raw: string): boolean {
  return raw.includes('/') || raw.includes('.') || raw.startsWith('~');
}

function withoutTrailingPunctuation(raw: string): string {
  let end = raw.length;
  while (end > 0 && TRAILING.has(raw[end - 1] as string)) end -= 1;
  return raw.slice(0, end);
}

/**
 * The line without its code spans: a run of backticks opens one, and the next run of the same length closes it; a
 * run with no partner is plain text (as in CommonMark). Each run's partner is found in one pass from the end.
 */
function withoutCodeSpans(line: string): string {
  if (!line.includes('`')) return line;
  const runs: { start: number; end: number }[] = [];
  for (let i = 0; i < line.length; ) {
    if (line[i] !== '`') {
      i += 1;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] === '`') j += 1;
    runs.push({ start: i, end: j });
    i = j;
  }
  const partner = new Array<number>(runs.length).fill(-1);
  const nextOfLength = new Map<number, number>();
  for (let k = runs.length - 1; k >= 0; k--) {
    const run = runs[k] as { start: number; end: number };
    partner[k] = nextOfLength.get(run.end - run.start) ?? -1;
    nextOfLength.set(run.end - run.start, k);
  }
  let out = '';
  let kept = 0;
  for (let k = 0; k < runs.length; ) {
    const close = partner[k] as number;
    if (close === -1) {
      k += 1;
      continue;
    }
    out += line.slice(kept, (runs[k] as { start: number }).start);
    kept = (runs[close] as { end: number }).end;
    k = close + 1;
  }
  return out + line.slice(kept);
}

/** The text without HTML comments; an unclosed one runs to the end. */
function withoutComments(text: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const open = text.indexOf('<!--', pos);
    if (open === -1) return out + text.slice(pos);
    out += text.slice(pos, open);
    const close = text.indexOf('-->', open + 4);
    if (close === -1) return out;
    pos = close + 3;
  }
}

/** Lines outside fenced code blocks, with code spans removed. */
function proseLines(text: string): string[] {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence === null) lines.push(withoutCodeSpans(line));
  }
  return lines;
}

/** The imports in the text of the rule file at `filePath`, each once. */
export function claudeImports(text: string, filePath: string): RuleImport[] {
  const folder = folderOfFile(filePath);
  const found: RuleImport[] = [];
  const seen = new Set<string>();
  for (const line of proseLines(text)) {
    for (const match of line.matchAll(IMPORT)) {
      const token = match[1] as string;
      if (token.length > MAX_IMPORT_CHARS) continue;
      const raw = withoutTrailingPunctuation(token);
      if (raw.length === 0 || !looksLikePath(raw)) continue;
      const external = raw.startsWith('~') || ABSOLUTE.test(raw);
      const path = external ? null : resolveRepoPath(folder, raw);
      const key = path ?? `external:${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ raw, path, external: path === null });
    }
  }
  return found;
}

/** True when the text holds imports and nothing else (blank lines and HTML comments aside). */
export function importsOnly(text: string): boolean {
  const lines = withoutComments(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 && lines.every((line) => line.split(/\s+/).every((token) => token.length > 1 && token.startsWith('@')));
}
