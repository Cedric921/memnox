import {
  SessionTasks,
  SPEAKER,
  type ConversationLine,
  type SessionHost,
} from '@memnox/core';
import { codexConversation, desktopRoots } from '../daemon/desktop-sessions';
import { readConversation, sessionTranscript } from '../daemon/transcript';
import type { SessionToolDeps } from './read-tools';

/**
 * A few lines only this session's tab shows, its latest request and reply and its task, so the Mac
 * can find it among a terminal app's tabs by what is in them when the app cannot say which tab is which.
 */

/** Apps the Mac finds the session's own tab in by its terminal, which need nothing more. */
const FINDS_ITS_TAB = /iterm|terminal|code|cursor|windsurf/i;

/** Long enough to be this session's own words, short enough to survive the terminal wrapping them. */
const MARK_CHARS = 40;

export async function sessionMarks(
  deps: SessionToolDeps,
  sessionId: string,
  host: SessionHost | null,
): Promise<string[]> {
  const app = host?.app ?? host?.appPath ?? '';
  if (host === null || app === '' || FINDS_ITS_TAB.test(app)) return [];
  const [path, task] = await Promise.all([
    sessionTranscript(deps.home, sessionId),
    new SessionTasks(deps.home).read(sessionId),
  ]);
  const lines =
    path === null
      ? codexConversation(desktopRoots(deps.home).codex, host.agentSession ?? sessionId)
      : readConversation(path);
  const marks = [
    latest(lines, SPEAKER.PERSON),
    latest(lines, SPEAKER.AGENT),
    task?.latestAsk,
    task?.statement,
  ]
    .filter((text): text is string => text !== undefined)
    .map((text) => text.replace(/\s+/g, ' ').trim().slice(0, MARK_CHARS))
    .filter((text) => text.length >= MARK_CHARS / 4);
  return [...new Set(marks)];
}

function latest(lines: readonly ConversationLine[], who: string): string | undefined {
  return [...lines].reverse().find((line) => line.who === who)?.text;
}
