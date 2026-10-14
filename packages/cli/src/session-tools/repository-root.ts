import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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

/** What HEAD holds while a branch is checked out, before the branch's name. */
const BRANCH_REF = 'ref: refs/heads/';
/** What a worktree's own `.git` file says before the folder git keeps for it. */
const GITDIR_LINE = /^gitdir:\s*(.+)$/m;

/**
 * The branch a repository has checked out, read from its HEAD on the disk, since a card polled
 * every few seconds should not start git for it; null when detached or unreadable.
 */
export function branchAt(root: string): string | null {
  try {
    const marker = join(root, GIT_MARKER);
    const pointer = statSync(marker).isFile()
      ? GITDIR_LINE.exec(readFileSync(marker, 'utf8'))?.[1]?.trim()
      : marker;
    if (pointer === undefined) return null;
    const head = readFileSync(join(resolve(root, pointer), 'HEAD'), 'utf8').trim();
    return head.startsWith(BRANCH_REF) ? head.slice(BRANCH_REF.length) : null;
  } catch {
    // Not a repository any more, or one git is rewriting this moment.
    return null;
  }
}
