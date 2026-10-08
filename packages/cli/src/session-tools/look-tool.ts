import { setTimeout as sleep } from 'node:timers/promises';
import { DISPLAY, DisplayRequests, type Sight } from '@memnox/core';
import { textArg, type SessionToolDeps, type ToolArgs } from './read-tools';
import type { ToolDefinition } from './session-tools';

/**
 * Looking at the person's screen: the brain asks, the Mac captures one window and reads its
 * controls, and the brain reads the capture itself. The Mac never decides from words when to look.
 */

export const LOOK_TOOL: ToolDefinition = {
  name: 'look',
  description:
    'See what is on the person\'s screen right now: the window in front, or the app they named. It returns a screenshot by its path, which you read as an image, and an outline of the window\'s buttons, fields and text. Use it when they ask what is on their screen, about what they are looking at, or to check something they point at with "this" or "here". It only looks and changes nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      app: {
        type: 'string',
        description:
          'the app to look at by its name, such as Safari; the window in front when left out',
      },
    },
  },
  // It reads the screen and changes nothing anywhere.
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

/** Long enough to capture a window and walk its controls. */
const SIGHT_WAIT_MS = 8_000;
const SIGHT_POLL_MS = 150;

const NOT_SEEN =
  'The Mac did not answer with what is on screen. Say you could not see it just now, and never describe the screen from a guess.';

const OUTLINE_ONLY =
  'Memnox may not record the screen, so only the outline of the window came back. Answer from it, say once that you could not see the picture, and that turning on Screen Recording for Memnox in System Settings lets you.';

export async function lookTool(deps: SessionToolDeps, args: ToolArgs): Promise<unknown> {
  const app = textArg(args, 'app');
  const request = await new DisplayRequests(deps.home).request({
    display: DISPLAY.LOOK,
    sessionId: 'screen',
    agent: 'memnox',
    title: app ?? '',
    at: deps.now().toISOString(),
  });
  const sight = await (deps.seen ?? ((id: string) => awaitSight(deps.home, id)))(
    request.id,
  );
  if (sight === null) return { seen: false, said: NOT_SEEN };
  return {
    seen: true,
    ...sight,
    ...(sight.image === undefined ? { said: OUTLINE_ONLY } : {}),
  };
}

/** What the Mac saw for a LOOK, or null when it said nothing in time. */
async function awaitSight(
  home: string,
  requestId: string,
  waitMs: number = SIGHT_WAIT_MS,
): Promise<Sight | null> {
  const requests = new DisplayRequests(home);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const sight = await requests.sightOf(requestId);
    if (sight !== null) return sight;
    await sleep(SIGHT_POLL_MS);
  }
  return null;
}
