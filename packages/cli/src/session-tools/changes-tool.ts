import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import {
  ACTION,
  LEDGER_SESSION_LIMIT,
  SESSION_VAR,
  SessionTasks,
  type MemnoxEvent,
  type Milestone,
} from '@memnox/core';
import { repositoryRootOf } from '@memnox/interceptors';
import { withEvents } from '../event-store';
import { MOST_ROWS } from './bounded';
import { textArg, type SessionToolDeps, type ToolArgs } from './read-tools';
import type { RewindSeams } from './rewind-tool';
import { scopeOf, type SessionScope } from './session-scope';

/**
 * What a session changed in the code, read against the milestone Memnox took before its
 * first write. The ledger keeps paths and digests and never content, so this is the one
 * place the words of a change are read, and only when the person asks.
 */

/** Enough folders to find the repositories a session wrote in, never a crawl of the disk. */
const MOST_PLACES = 20;

/** The same session reads, with the operator's own run taken out so it never reads itself. */
export function readingFor(deps: SessionToolDeps, agent: string): SessionToolDeps {
  const env = { ...deps.env };
  delete env[SESSION_VAR];
  return { ...deps, agent, env };
}

interface Found {
  scope: SessionScope;
  places: string[];
  /** Absolute paths the session wrote or deleted, from the ledger. */
  written: string[];
}

const WRITES: readonly string[] = [ACTION.FILESYSTEM_WRITE, ACTION.FILESYSTEM_DELETE];

export async function changesTool(
  deps: SessionToolDeps,
  seams: RewindSeams,
  args: ToolArgs,
): Promise<unknown> {
  const found = await sessionAndPlaces(deps, textArg(args, 'session'));
  const { scope } = found;
  if (scope.sessionId === null) return { ...scope, found: false };
  const task = await new SessionTasks(deps.home).read(scope.sessionId);
  const head = { ...scope, ...(task === null ? {} : { task: task.statement }) };
  const answer =
    (await sinceMilestone(deps, seams, args, found)) ??
    (await sinceCommit(seams, args, found));
  return answer === null
    ? {
        ...head,
        found: false,
        said: 'This session wrote no file in a repository Memnox could find, so there is nothing to compare.',
      }
    : { ...head, ...answer };
}

/** Against the milestone taken before the session's first write, which is the exact start. */
async function sinceMilestone(
  deps: SessionToolDeps,
  seams: RewindSeams,
  args: ToolArgs,
  { scope, places }: Found,
): Promise<Record<string, unknown> | null> {
  const asked = textArg(args, 'repository');
  for (const place of asked === undefined ? [...places, deps.cwd] : [asked]) {
    const start = firstMilestoneOf(await deps.milestonesAt(place), scope.sessionId ?? '');
    if (start === undefined) continue;
    const milestones = seams.build(place);
    const path = textArg(args, 'path');
    return {
      repository: place,
      since: start.takenAt,
      ...(path === undefined
        ? { files: listed(await milestones.changedSince(start.id)) }
        : { path, diff: firstLines(await milestones.diffSince(start.id, path)) }),
    };
  }
  return null;
}

/** Against the last commit, kept to the files the ledger says this session wrote. */
async function sinceCommit(
  seams: RewindSeams,
  args: ToolArgs,
  { places, written }: Found,
): Promise<Record<string, unknown> | null> {
  const asked = textArg(args, 'repository');
  for (const place of asked === undefined ? places : [asked]) {
    const mine = written
      .filter((each) => each.startsWith(`${place}/`))
      .map((each) => relative(place, each));
    if (mine.length === 0) continue;
    const milestones = seams.build(place);
    const path = textArg(args, 'path');
    // The tree since the last commit holds everybody's work, so only this session's files are kept.
    const files = (await milestones.changedSinceCommit()).filter((each) =>
      mine.includes(each.path),
    );
    return {
      repository: place,
      comparedWith: 'the last commit, since no milestone was taken for this session',
      ...(path === undefined
        ? { files: listed(files) }
        : { path, diff: firstLines(await milestones.diffSinceCommit(path)) }),
    };
  }
  return null;
}

async function sessionAndPlaces(deps: SessionToolDeps, session?: string): Promise<Found> {
  return withEvents(deps.home, async (store) => {
    const scope = await scopeOf(store, deps.agent, deps.env, session);
    const rows =
      scope.sessionId === null
        ? []
        : await store.query({ sessionId: scope.sessionId, limit: LEDGER_SESSION_LIMIT });
    const written = rows
      .filter((each) => WRITES.includes(each.operation) && each.target !== undefined)
      .map((each) => each.target ?? '')
      .filter((each) => isAbsolute(each))
      .map(resolved);
    return { scope, places: repositoriesOf(rows), written: [...new Set(written)] };
  });
}

/** The repositories the session's own paths sit in, found from the paths and never guessed. */
export function repositoriesOf(events: readonly MemnoxEvent[]): string[] {
  const folders = new Set<string>();
  for (const event of events) {
    if (event.target !== undefined && isAbsolute(event.target))
      folders.add(dirname(event.target));
    if (folders.size >= MOST_PLACES) break;
  }
  const roots = new Set<string>();
  for (const folder of folders) {
    const root = repositoryRootOf(folder);
    if (root !== null) roots.add(root);
  }
  return [...roots];
}

/** The milestone taken before the session's first write, which is where its changes start. */
function firstMilestoneOf(
  milestones: readonly Milestone[],
  sessionId: string,
): Milestone | undefined {
  return milestones
    .filter((each) => each.sessionId === sessionId)
    .sort((a, b) => a.takenAt.localeCompare(b.takenAt))[0];
}

function listed<T>(rows: readonly T[]): { total: number; shown: T[] } {
  return { total: rows.length, shown: rows.slice(0, MOST_ROWS) };
}

/** The start of a diff, since the answer keeps a list's newest rows and a diff reads from the top. */
function firstLines(diff: string): { total: number; lines: string[] } {
  const lines = diff.split('\n');
  return { total: lines.length, lines: lines.slice(0, MOST_ROWS) };
}

/** The path as git prints its root, since /var and /private/var are one folder to the disk and two to a string. */
function resolved(path: string): string {
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    // The folder is gone, so the path is kept as the ledger wrote it.
    return path;
  }
}
