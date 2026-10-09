import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The repository a folder is in, found on the disk rather than by starting git, since a session
 * list asks it of every folder every session touched and a process each made that seconds long.
 */

/** Each folder's repository once found, since the same few folders come up in every session listed. */
const ROOTS_FOUND = new Map<string, string>();
/** A folder that holds this, as a folder or a worktree's file, is a repository's top. */
const GIT_MARKER = '.git';

/**
 * The repository a folder is in, from the nearest folder above holding `.git`, as `git rev-parse
 * --show-toplevel` answers it, read off the disk rather than by starting git for every folder.
 */
export function repositoryAround(folder: string): string | null {
  const known = ROOTS_FOUND.get(folder);
  if (known !== undefined) return known;
  // Not kept when none is found, since a folder can become a repository while the daemon runs.
  let current = folder;
  let found: string | null = null;
  while (true) {
    if (existsSync(join(current, GIT_MARKER))) {
      found = current;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (found !== null) ROOTS_FOUND.set(folder, found);
  return found;
}
