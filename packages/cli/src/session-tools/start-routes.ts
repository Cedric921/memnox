import { basename } from 'node:path';
import {
  DELIVERY,
  DISPLAY,
  DISPLAY_VIA,
  DisplayRequests,
  wentIn,
  type DisplayDelivery,
  type SessionStart,
} from '@memnox/core';
import { FOCUS_STARTED, noteFocus } from './focus';
import { unlessMacTold } from './mac-told';
import { witnessed } from './witnessed';
import { multiplexerNamed, openPane, typeIntoPane } from './multiplexer';
import type { SessionToolDeps } from './read-tools';
import { editorName } from './start-place';
import { questionBeforeStart } from './start-question';

/**
 * How a start reaches where it runs beyond a terminal tab, and what may be said of it once there:
 * started only when the agent showed itself running, never because a line was typed.
 */

/**
 * A new conversation in the editor's Claude Code panel with the task as its first message. It runs
 * with the hooks Claude Code reads from its settings, so it is governed without `memnox run`.
 */
export async function startInPanel(
  deps: SessionToolDeps,
  start: SessionStart,
  moment: string,
): Promise<Record<string, unknown>> {
  const request = await new DisplayRequests(deps.home).request({
    display: DISPLAY.LAUNCH,
    sessionId: start.id,
    agent: start.agent,
    title: start.agent,
    text: start.task,
    cwd: start.repository,
    ...(start.editor === undefined ? {} : { appPath: start.editor }),
    via: DISPLAY_VIA.PANEL,
    at: moment,
  });
  const delivery = deps.delivered === undefined ? null : await deps.delivered(request.id);
  return launched(deps, start, delivery, moment);
}

/** A new window in the tmux or WezTerm running here, with the line typed in through it, no Mac needed. */
export async function startInPane(
  deps: SessionToolDeps,
  start: SessionStart,
  line: string,
  moment: string,
): Promise<Record<string, unknown>> {
  const multiplexer = multiplexerNamed(start.pane ?? '');
  const pane =
    multiplexer === null ? null : openPane(multiplexer, start.repository, deps.panes);
  const typed =
    pane === null ? { sent: false } : await typeIntoPane(pane, line, deps.panes);
  const delivery: DisplayDelivery = typed.sent
    ? { outcome: DELIVERY.TYPED, at: moment }
    : {
        outcome: DELIVERY.FAILED,
        at: moment,
        reason: `${start.pane ?? 'the multiplexer'} would not open a window and take the line`,
      };
  return launched(deps, start, delivery, moment);
}

/** What the Mac reported for the tab, checked against whether the agent itself came up. */
export async function launched(
  deps: SessionToolDeps,
  start: SessionStart,
  delivery: DisplayDelivery | null,
  moment: string,
): Promise<Record<string, unknown>> {
  const handed = delivery === null || wentIn(delivery.outcome);
  // Typed is not running: a missing command or a shell prompt left waiting looks the same to the Mac.
  const found =
    handed && deps.startSeen !== undefined
      ? await deps.startSeen(start.repository, moment)
      : undefined;
  // The session itself once it showed up, so "there" and "that session" mean it from the next words on.
  if (handed) {
    await noteFocus(
      deps,
      { ...start, ...(typeof found === 'string' ? { sessionId: found } : {}) },
      FOCUS_STARTED,
    );
  }
  const seen = found === undefined ? null : found !== null;
  // Not up yet is most often the agent asking something in its tab before its first hook.
  const asking =
    seen === false ? await questionBeforeStart(deps, start.repository, moment) : {};
  return {
    repository: basename(start.repository),
    ...(typeof found === 'string' ? { session: found } : {}),
    ...(start.editor === undefined ? {} : { in: editorName(deps, start) }),
    ...witnessed(delivery),
    ...startedAs(
      delivery,
      seen,
      start.editor === undefined ? STARTED : STARTED_IN_EDITOR,
    ),
    ...asking,
  };
}

/** What the brain may say, from what the Mac reported, so a tab that never opened is never called working. */
function startedAs(
  delivery: DisplayDelivery | null,
  seen: boolean | null,
  started: string,
): Record<string, unknown> {
  if (seen === true) return { started: true, said: started };
  if (delivery === null) return { started: true, said: UNCONFIRMED };
  if (wentIn(delivery.outcome))
    return seen === false
      ? { started: true, confirmed: false, said: NOT_SEEN }
      : { started: true, said: started };
  return {
    started: false,
    ...(delivery.reason === undefined ? {} : { why: delivery.reason }),
    said: unlessMacTold(delivery, NOT_STARTED),
  };
}

const UNCONFIRMED =
  'Handed to the Mac to open a tab and start it, and neither the Mac nor the agent has said it is running yet. Say you asked for it and it has not come up yet; never that it is starting or working.';
const NOT_SEEN =
  'The Mac typed the line that starts it into a new terminal, but the agent has not shown itself running there yet. Say in one sentence that you typed it in and it has not come up yet, and offer to check it for them; never say it is starting or working.';
const NOT_STARTED =
  'The Mac could not open the tab and start it. Say sorry in a few words and say why in plain words; nothing started.';
const STARTED =
  'A new terminal tab opened in that repository and the agent is starting on the task. Say so in a few words, and offer to tell them when it finishes.';
const STARTED_IN_EDITOR =
  'A new terminal opened inside the editor named in, on that repository, and the agent is starting on the task there. Say so in a few words, naming the editor, like "Claude Code is starting in VS Code on memnox runtime.", and offer to tell them when it finishes.';
