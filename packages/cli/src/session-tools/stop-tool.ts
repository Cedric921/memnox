import {
  DISPLAY,
  DisplayRequests,
  SessionHosts,
  SessionTurns,
  wentIn,
  type DisplayDelivery,
} from '@memnox/core';
import { liveHost } from './live-host';
import { unlessMacTold } from './mac-told';
import type { SessionToolDeps } from './read-tools';
import type { SessionScope } from './session-scope';

/**
 * Stopping an agent where it is, as a person does at the keyboard: Escape in the terminal it runs
 * in. The turn ends, the tab and its conversation stay, and the next instruction picks up from there.
 */
export async function stopSession(
  deps: SessionToolDeps,
  scope: SessionScope,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const recorded = await new SessionHosts(deps.home).read(sessionId);
  const live = recorded === null ? null : liveHost(recorded);
  const tty = live?.panel === true ? undefined : live?.tty;
  // An editor's agent panel and a desktop app have no terminal, so there is nowhere to press it.
  if (tty === undefined) return { ...scope, stopped: false, said: NO_TERMINAL };
  const request = await new DisplayRequests(deps.home).request({
    display: DISPLAY.INTERRUPT,
    sessionId,
    agent: scope.agent,
    title: 'Stop',
    tty,
    at: deps.now().toISOString(),
  });
  const delivery = deps.delivered === undefined ? null : await deps.delivered(request.id);
  // No hook says a turn ended when it was interrupted, so it is recorded here or it would look busy for hours.
  if (delivery !== null && wentIn(delivery.outcome)) {
    await new SessionTurns(deps.home).ended(
      sessionId,
      scope.agent,
      deps.now().toISOString(),
    );
  }
  return { ...scope, ...stoppedAs(delivery) };
}

/** What the brain may say, from what the Mac reported, so an agent still working is never called stopped. */
function stoppedAs(delivery: DisplayDelivery | null): Record<string, unknown> {
  if (delivery === null) return { stopped: false, said: STOP_UNCONFIRMED };
  if (wentIn(delivery.outcome)) return { stopped: true, said: STOPPED };
  return {
    stopped: false,
    ...(delivery.reason === undefined ? {} : { why: delivery.reason }),
    said: unlessMacTold(delivery, NOT_STOPPED),
  };
}

const STOPPED =
  'Escape was pressed in its terminal, which stops whatever it was doing there and leaves its tab and conversation as they are. Say it is stopped in a few words, and that it is waiting for what to do next.';
const STOP_UNCONFIRMED =
  'Handed to the Mac to press Escape in its terminal, which has not said it went in. Say you asked it to stop and could not confirm it yet; never that it stopped.';
const NOT_STOPPED =
  'The Mac could not press Escape in its terminal, so it is still going: why says the reason. Say sorry in a few words and the reason in plain words, then offer as one question to pause it, which holds it at its next step, or to close its tab now.';
const NO_TERMINAL =
  'It runs where there is no terminal to press Escape in, such as an editor panel or a desktop app, so nothing was stopped. Say so in a sentence and offer as one question to pause it, which holds it at its next step.';
