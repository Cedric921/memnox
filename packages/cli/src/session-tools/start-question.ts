import { DISPLAY, DisplayRequests, RunTerminals } from '@memnox/core';
import { awaitSight } from './look-tool';
import type { SessionToolDeps } from './read-tools';

/**
 * A start whose agent never showed itself running: `memnox run` came up in its tab, so the agent is
 * most likely stopped on a question of its own before its first hook, such as whether to trust the
 * folder. The tab is read so the voice can put that question to the person rather than wait.
 */

/** The end of a terminal is where its question is, and enough of it to hold every choice. */
const MOST_SCREEN_CHARS = 1_200;

export async function questionBeforeStart(
  deps: SessionToolDeps,
  repository: string,
  since: string,
): Promise<Record<string, unknown>> {
  const run = await new RunTerminals(deps.home).startedIn(repository, since);
  if (run === null) return {};
  const request = await new DisplayRequests(deps.home).request({
    display: DISPLAY.LOOK,
    sessionId: run.sessionId,
    agent: run.agent,
    title: run.app ?? '',
    at: deps.now().toISOString(),
  });
  const sight = await (deps.seen ?? ((id: string) => awaitSight(deps.home, id)))(
    request.id,
  );
  const screen = sight?.text?.trim().slice(-MOST_SCREEN_CHARS);
  if (screen === undefined || screen === '')
    return { session: run.sessionId, said: UP_NOT_READ };
  return { session: run.sessionId, screen, said: ASKING_FIRST };
}

const ASKING_FIRST =
  'The agent came up in its tab but has not started its session: screen is what its tab shows now. When it shows a question with choices, such as whether to trust this folder, say in one sentence what it asks and the choices, plainly, like "Claude Code is asking whether you trust the studiolabs folder before it starts. Shall I say yes?", and on their answer call answer_agent with this session and the keys that pick what they chose. Never answer it yourself. When it shows no question, say it has not come up yet and they can ask you to check.';
const UP_NOT_READ =
  'The agent came up in its tab but has not started its session, and its tab could not be read. Say in one sentence that it may be asking something in its terminal before it starts, and offer to look.';
