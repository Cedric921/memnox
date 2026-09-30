import { dirname, isAbsolute } from 'node:path';
import {
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
}

export async function changesTool(
  deps: SessionToolDeps,
  seams: RewindSeams,
  args: ToolArgs,
): Promise<unknown> {
  const { scope, places } = await sessionAndPlaces(deps, textArg(args, 'session'));
  if (scope.sessionId === null) return { ...scope, found: false };
  const task = await new SessionTasks(deps.home).read(scope.sessionId);
  const asked = textArg(args, 'repository');
  for (const place of asked === undefined ? [...places, deps.cwd] : [asked]) {
    const start = firstMilestoneOf(await deps.milestonesAt(place), scope.sessionId);
    if (start === undefined) continue;
    const milestones = seams.build(place);
    const path = textArg(args, 'path');
    return {
      ...scope,
      ...(task === null ? {} : { task: task.statement }),
      repository: place,
      since: start.takenAt,
      ...(path === undefined
        ? { files: listed(await milestones.changedSince(start.id)) }
        : { path, diff: firstLines(await milestones.diffSince(start.id, path)) }),
    };
  }
  return {
    ...scope,
    ...(task === null ? {} : { task: task.statement }),
    found: false,
    said: 'No milestone was taken for this session, so there is nothing to compare its changes against.',
  };
}

async function sessionAndPlaces(deps: SessionToolDeps, session?: string): Promise<Found> {
  return withEvents(deps.home, async (store) => {
    const scope = await scopeOf(store, deps.agent, deps.env, session);
    const rows =
      scope.sessionId === null
        ? []
        : await store.query({ sessionId: scope.sessionId, limit: LEDGER_SESSION_LIMIT });
    return { scope, places: repositoriesOf(rows) };
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
