/**
 * Matching owned-path entries against reserved or forbidden path patterns.
 *
 * Pattern rules (gitignore-like, always case-insensitive):
 * - `name` (no slash): matches a file or folder with that name at any depth.
 * - `dir/sub/file` (contains a slash) or `/name` (a leading slash): anchored at the repository root.
 * - a trailing `/` or `/**` makes it a folder pattern: the folder itself and everything inside it.
 * - `*` matches within one name, `?` one character, `**` any number of folders.
 * - a bracket around exactly one character (`[*]`, `[?]`, `[[]`, `[ ]`) is that character itself, never a
 *   wildcard: literalPattern uses it to reserve one exact path, whatever its name holds. Other brackets are
 *   literal text.
 *
 * An entry matches when the entry itself or any of its parent folders matches. Folder patterns are not
 * applied to a file entry's own name.
 */

import type { OwnsEntry } from './paths.js';

interface CompiledPattern {
  readonly source: string;
  readonly regex: RegExp;
  readonly anchored: boolean;
  readonly folderOnly: boolean;
}

export interface PatternMatcher {
  /** Returns the first pattern (as written) that matches the entry, or null. */
  match(entry: OwnsEntry): string | null;
}

function globToRegexBody(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '[' && i + 2 < glob.length && glob[i + 2] === ']' && glob[i + 1] !== '/') {
      // One character in brackets: that character, literally.
      out += escapeRegex(glob[i + 1] as string);
      i += 2;
    } else {
      out += escapeRegex(ch);
    }
  }
  return out;
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileOne(source: string): CompiledPattern | null {
  let body = source.trim().replace(/\\/g, '/').toLowerCase().normalize('NFC');
  if (body.length === 0) return null;

  let folderOnly = false;
  if (body.endsWith('/**')) {
    body = body.slice(0, -3);
    folderOnly = true;
  } else if (body.endsWith('/')) {
    body = body.slice(0, -1);
    folderOnly = true;
  }
  const leadingSlash = body.startsWith('/');
  if (leadingSlash) body = body.slice(1);
  if (body.length === 0) return null;

  const anchored = leadingSlash || body.includes('/');
  return { source, regex: new RegExp(`^${globToRegexBody(body)}$`), anchored, folderOnly };
}

export function compilePatterns(patterns: readonly string[]): PatternMatcher {
  const compiled = patterns.map(compileOne).filter((p): p is CompiledPattern => p !== null);

  return {
    match(entry: OwnsEntry): string | null {
      const segments = entry.key.split('/');
      for (const pattern of compiled) {
        for (let depth = 1; depth <= segments.length; depth++) {
          const isEntryItself = depth === segments.length;
          const candidateIsFolder = !isEntryItself || entry.isFolder;
          if (pattern.folderOnly && !candidateIsFolder) continue;

          const subject = pattern.anchored ? segments.slice(0, depth).join('/') : (segments[depth - 1] as string);
          if (pattern.regex.test(subject)) return pattern.source;
        }
      }
      return null;
    },
  };
}

/** Characters patterns read as wildcards, and `[`, which starts a one-character escape. */
const SPECIAL = new Set(['*', '?', '[']);

/**
 * A pattern that matches exactly one repo-relative file path (and, like every file pattern, a folder of that name),
 * whatever characters its name holds: anchored with a leading slash, with `*`, `?` and `[` and trailing white
 * space written as one-character brackets. Null for what no pattern can name: an empty or absolute path, a folder
 * (ending in "/"), or a name with a backslash (patterns read it as a folder separator).
 */
export function literalPattern(path: string): string | null {
  if (path.length === 0 || path.startsWith('/') || path.endsWith('/') || path.includes('\\')) return null;
  const chars = [...path];
  // Trailing white space is trimmed from patterns, so it is bracketed; so is every special character.
  let keepTrailing = chars.length;
  while (keepTrailing > 0 && /\s/u.test(chars[keepTrailing - 1] as string)) keepTrailing--;
  const body = chars.map((ch, i) => (SPECIAL.has(ch) || i >= keepTrailing ? `[${ch}]` : ch)).join('');
  return `/${body}`;
}
