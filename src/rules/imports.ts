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

const IMPORT = /(?:^|[\s(])@([^\s]+)/g;
const TRAILING = /[.,;:!?)\]}'"]+$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const CODE_SPAN = /(`+)[\s\S]*?\1/g;
const ABSOLUTE = /^(?:[\\/]|[A-Za-z]:)/;

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
    if (fence === null) lines.push(line.replace(CODE_SPAN, ''));
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
      const raw = (match[1] as string).replace(TRAILING, '');
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
  const lines = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 && lines.every((line) => /^(?:@\S+\s*)+$/.test(line));
}
