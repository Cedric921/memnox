import { SessionViews } from '../daemon/session-view';
import { withEvents } from '../event-store';
import { textArg, type SessionToolDeps, type ToolArgs } from './read-tools';
import { scopeOf } from './session-scope';

/**
 * Everything about one session in one call: its state and task, the latest of its
 * conversation, its last steps and the files it changed. One call where the brain used to make
 * three is most of the wait between a question and its answer.
 */
const LAST_ANSWER =
  'lastAnswer is what the agent told the person to end its latest turn, which is what it found or did. When they ask what it found, said or concluded, answer from it in a sentence or two of your own words: the finding first, never read out a list or its markdown.';

export async function sessionTool(
  deps: SessionToolDeps,
  args: ToolArgs,
): Promise<unknown> {
  const scope = await withEvents(deps.home, (store) =>
    scopeOf(store, deps, textArg(args, 'session')),
  );
  if (scope.sessionId === null) return { ...scope, found: false };
  const views = new SessionViews(deps.home, deps.now);
  const [view, lastAnswer] = await Promise.all([
    views.view(scope.sessionId),
    views.lastAnswer(scope.sessionId),
  ]);
  if (view === null) return { ...scope, found: false };
  return {
    ...scope,
    found: true,
    ...view,
    ...(lastAnswer === null ? {} : { lastAnswer, said: LAST_ANSWER }),
  };
}
