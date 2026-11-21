/**
 * Finding programs in PATH without ever searching the current folder.
 *
 * A bare program name started from a folder a worker controls is the classic trap: Windows looks in the
 * current folder before PATH, and an empty, "." or relative PATH entry does the same on any system. Only
 * PATH's absolute folders are searched here.
 */

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute } from 'node:path';

/** PATH's value (Windows spells the variable "Path"; a copied environment loses the case-insensitivity). */
export function pathValue(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return key === undefined ? '' : (env[key] ?? '');
}

/** PATH's absolute folders in order, without surrounding quotes. Empty, "." and relative entries are left out. */
export function absolutePathFolders(env: NodeJS.ProcessEnv): string[] {
  const folders: string[] = [];
  for (const entry of pathValue(env).split(delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, '$1');
    if (dir.length > 0 && isAbsolute(dir)) folders.push(dir);
  }
  return folders;
}

/** A regular file this process could start (on Windows, any regular file; elsewhere, also executable). */
export function isRunnableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
