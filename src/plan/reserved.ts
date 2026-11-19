/**
 * Matching owned-path entries against reserved or forbidden path patterns.
 *
 * Pattern rules (gitignore-like, always case-insensitive):
 * - `name` (no slash): matches a file or folder with that name at any depth.
 * - `dir/sub/file` (contains a slash): anchored at the repository root.
 * - a trailing `/` or `/**` makes it a folder pattern: the folder itself and everything inside it.
 * - `*` matches within one name, `?` one character, `**` any number of folders.
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
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
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
  if (body.startsWith('/')) body = body.slice(1);
  if (body.length === 0) return null;

  const anchored = body.includes('/');
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
