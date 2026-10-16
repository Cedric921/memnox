import {
  DISPLAY,
  DisplayRequests,
  SessionHosts,
  SessionTurns,
  wentIn,
  type DisplayDelivery,
} from '@memnox/core';
import { liveHost } from './live-host';
import { sessionMarks } from './session-marks';
import { unlessMacTold } from './mac-told';
import { witnessed } from './witnessed';
import { paneOn, pressEscapeIn, type Pane } from './multiplexer';
import type { SessionToolDeps } from './read-tools';
import type { SessionScope } from './session-scope';
import { FINDS_ITS_TAB } from './session-tools.constants';

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
  const inPanel = live?.panel === true;
  const tty = inPanel ? undefined : live?.tty;
  // An editor's agent panel is stopped by the Mac in its conversation; nothing else without a terminal can be.
  if (tty === undefined && !inPanel)
    return { ...scope, stopped: false, said: NO_TERMINAL };
  const pane =
    tty === undefined || FINDS_ITS_TAB.test(live?.app ?? '')
      ? null
      : paneOn(tty, deps.panes);
  if (pane !== null) return stoppedInPane(deps, scope, sessionId, pane);
  const marks = await sessionMarks(deps, sessionId, live);
  const request = await new DisplayRequests(deps.home).request({
    display: DISPLAY.INTERRUPT,
    sessionId,
    marks,
    agent: scope.agent,
    title: STOP_TITLE,
    tty,
    at: deps.now().toISOString(),
  });
  const delivery = deps.delivered === undefined ? null : await deps.delivered(request.id);
  if (delivery !== null && wentIn(delivery.outcome))
    await turnOver(deps, scope, sessionId);
  return { ...scope, ...stoppedAs(delivery), ...witnessed(delivery) };
}

/** No hook says a turn ended when it was interrupted, so it is recorded here or it would look busy for hours. */
function turnOver(
  deps: SessionToolDeps,
  scope: SessionScope,
  sessionId: string,
): Promise<void> {
  return new SessionTurns(deps.home).ended(
    sessionId,
    scope.agent,
    deps.now().toISOString(),
  );
}

/** A tmux or WezTerm pane takes the key from its own command line, whatever app shows it. */
async function stoppedInPane(
  deps: SessionToolDeps,
  scope: SessionScope,
  sessionId: string,
  pane: Pane,
): Promise<Record<string, unknown>> {
  if (!pressEscapeIn(pane, deps.panes)) {
    return {
      ...scope,
      stopped: false,
      why: `${pane.multiplexer} would not take the key`,
      said: NOT_STOPPED,
    };
  }
  await turnOver(deps, scope, sessionId);
  return { ...scope, stopped: true, said: STOPPED };
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

/** What the Mac's card is headed while it stops the session. */
const STOP_TITLE = 'Stop';

const STOPPED =
  'Escape was pressed in its terminal, which stops whatever it was doing there and leaves its tab and conversation as they are. Say it is stopped in a few words, and that it is waiting for what to do next.';
const STOP_UNCONFIRMED =
  'Handed to the Mac to press Escape in its terminal, which has not said it went in. Say you asked it to stop and could not confirm it yet; never that it stopped.';
const NOT_STOPPED =
  'The Mac could not press Escape in its terminal, so it is still going: why says the reason. Say sorry in a few words and the reason in plain words, then offer as one question to pause it, which holds it at its next step, or to close its tab now.';
const NO_TERMINAL =
  'It runs where Memnox cannot press Escape, such as a desktop app it has no window for, so nothing was stopped. Say so in a sentence and offer as one question to pause it, which holds it at its next step.';
