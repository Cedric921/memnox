import { SessionWatches, UNNAMED_SESSION, WATCH_FOR, type WatchFor } from '@memnox/core';
import { withEvents } from '../event-store';
import { noteFocus } from './focus';
import { textArg, type SessionToolDeps, type ToolArgs } from './read-tools';
import { scopeOf } from './session-scope';

/**
 * "Tell me when the tests pass": a watch on one session that speaks up once, when it happens.
 * It changes nothing an agent can do, so it is set at once, with no confirmation.
 */

const WATCHABLE: readonly string[] = Object.values(WATCH_FOR);

const SET =
  'Set. You will be told out loud when it happens, even if they walk away. Say so in a few words, like "I\'ll tell you when the tests pass."';

export async function watchForTool(
  deps: SessionToolDeps,
  args: ToolArgs,
): Promise<unknown> {
  const asked = textArg(args, 'for') ?? WATCH_FOR.FINISHED;
  if (!WATCHABLE.includes(asked)) {
    return {
      watching: false,
      said: `for is one of ${WATCHABLE.join(', ')}, not "${asked}".`,
    };
  }
  const scope = await withEvents(deps.home, (store) =>
    scopeOf(store, deps, textArg(args, 'session')),
  );
  if (scope.sessionId === null || scope.sessionId === UNNAMED_SESSION) {
    return { ...scope, watching: false, said: 'No agent session was found to watch.' };
  }
  const said = textArg(args, 'said');
  const watch = await new SessionWatches(deps.home).set({
    sessionId: scope.sessionId,
    agent: scope.agent,
    for: asked as WatchFor, // narrowed by the includes check above
    ...(said === undefined ? {} : { said }),
    at: deps.now().toISOString(),
  });
  await noteFocus(deps, scope, 'watched');
  return { ...scope, watching: true, watch: watch.id, for: watch.for, said: SET };
}
