import { basename } from 'node:path';
import { HOUR_MS, LEDGER_SCAN_LIMIT, LEDGER_SESSION_LIMIT, NodeGit } from '@memnox/core';
import { withEvents } from '../event-store';
import { repositoriesOf } from './changes-tool';
import { textArg, type SessionToolDeps, type ToolArgs } from './read-tools';
import { scopeOf } from './session-scope';

/**
 * Which branch a session's repository is on and the commits made there since it started,
 * read from git itself, so "read the commit it just made" has the commit to read.
 */

/** Enough commits to cover a working session, few enough to say out loud. */
const MOST_COMMITS = 10;
/** Enough repositories for one question, never a sweep of every folder touched. */
const MOST_REPOSITORIES = 3;
/** How far back to look for repositories and commits when no session is named or found. */
const RECENT_HOURS = 24;

interface Commit {
  sha: string;
  at: string;
  subject: string;
  files: string[];
}

export async function repositoryTool(
  deps: SessionToolDeps,
  args: ToolArgs,
): Promise<unknown> {
  const since = new Date(deps.now().getTime() - RECENT_HOURS * HOUR_MS).toISOString();
  const found = await withEvents(deps.home, async (store) => {
    const scope = await scopeOf(store, deps, textArg(args, 'session'));
    const mine =
      scope.sessionId === null
        ? []
        : await store.query({ sessionId: scope.sessionId, limit: LEDGER_SESSION_LIMIT });
    const recent = await store.query({ since, limit: LEDGER_SCAN_LIMIT });
    return { scope, mine, recent };
  });
  const startedAt = found.mine.map((each) => each.at).sort()[0] ?? since;
  const places = chosen(
    repositoriesOf(found.mine),
    repositoriesOf(found.recent),
    textArg(args, 'repository'),
  );
  const repositories = [];
  for (const place of places.slice(0, MOST_REPOSITORIES)) {
    repositories.push(await describeRepository(place, startedAt));
  }
  return {
    ...found.scope,
    commitsSince: startedAt,
    repositories,
    ...(repositories.length === 0
      ? { said: 'No repository was found for this session or by that name.' }
      : {}),
  };
}

/** The session's own repositories, or the one named, matched by folder name against what was touched lately. */
function chosen(
  mine: readonly string[],
  recent: readonly string[],
  asked: string | undefined,
): string[] {
  if (asked === undefined) return [...mine];
  const wanted = asked.toLowerCase();
  const pool = [...new Set([...mine, ...recent])];
  const exact = pool.filter(
    (each) => each === asked || basename(each).toLowerCase() === wanted,
  );
  return exact.length > 0
    ? exact
    : pool.filter((each) => basename(each).toLowerCase().includes(wanted));
}

async function describeRepository(
  place: string,
  since: string,
): Promise<Record<string, unknown>> {
  const git = new NodeGit(place);
  const branch = await git
    .run(['rev-parse', '--abbrev-ref', 'HEAD'])
    .catch(() => 'unknown');
  const log = await git
    .run([
      'log',
      `--since=${since}`,
      `-n`,
      String(MOST_COMMITS),
      '--name-only',
      '--format=%x1e%h%x1f%aI%x1f%s',
    ])
    .catch(() => '');
  return { repository: place, name: basename(place), branch, commits: commitsIn(log) };
}

/** git log split on the record separator each commit starts with, its files on the lines after. */
function commitsIn(log: string): Commit[] {
  return log
    .split('\u001e')
    .map((each) => each.trim())
    .filter((each) => each !== '')
    .map((record) => {
      const [head = '', ...files] = record.split('\n');
      const [sha = '', at = '', subject = ''] = head.split('\u001f');
      return { sha, at, subject, files: files.filter((each) => each !== '') };
    });
}
