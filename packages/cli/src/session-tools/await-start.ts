import { relative, isAbsolute } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { SessionHosts } from '@memnox/core';

/** Long enough for an agent's own start hook, short enough that the person is not left in silence. */
const START_WAIT_MS = 6_000;
const START_POLL_MS = 300;

/**
 * Whether a session began in this repository since the start was typed, from the note its own
 * start hook writes, which is the only thing that says the agent is running rather than typed.
 */
export async function awaitSessionStart(
  home: string,
  repository: string,
  since: string,
  waitMs: number = START_WAIT_MS,
): Promise<boolean> {
  const hosts = new SessionHosts(home);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const all = await hosts.all();
    if (all.some((host) => host.seenAt >= since && within(repository, host.cwd)))
      return true;
    await sleep(START_POLL_MS);
  }
  return false;
}

function within(repository: string, cwd: string | undefined): boolean {
  if (cwd === undefined) return false;
  const path = relative(repository, cwd);
  return !path.startsWith('..') && !isAbsolute(path);
}
