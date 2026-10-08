import { basename } from 'node:path';
import {
  readHermesMessages,
  readHermesSessions,
  SPEAKER,
  type ConversationLine,
  type HermesSession,
  type SessionCard,
  type SessionView,
} from '@memnox/core';

/**
 * Hermes sessions as cards and live views, read from Hermes's own database, so a server where
 * Hermes runs shows its work on the phone and the Mac the way a Claude Code session does.
 */

/** Marks a session as Hermes's own id rather than a ledger session, so a view is read from Hermes. */
export const HERMES_SESSION_PREFIX = 'hermes:';

const HERMES = 'hermes';

/** Lately, as the ledger's own list looks back three days. */
const LOOK_BACK_MS = 72 * 60 * 60 * 1_000;

/** A session that said something this recently counts as working. */
const WORKING_WITHIN_MS = 2 * 60 * 1_000;

const STATE = { WORKING: 'working', OPEN: 'open' } as const;

const SPOKEN: Readonly<Record<string, ConversationLine['who']>> = {
  person: SPEAKER.PERSON,
  agent: SPEAKER.AGENT,
  tool: SPEAKER.TOOL,
};

/** Every Hermes session still open lately, as switcher cards named the way the person named Hermes. */
export function hermesCards(
  home: string,
  now: Date,
  agentName: string,
  read: typeof readHermesSessions = readHermesSessions,
): SessionCard[] {
  return read(home, new Date(now.getTime() - LOOK_BACK_MS))
    .filter((session) => session.endedAt === undefined)
    .map((session) => cardOf(session, now, agentName));
}

/** One Hermes session as the live window shows it, or null when Hermes has no such session. */
export function hermesView(
  home: string,
  sessionId: string,
  input: { now: Date; agentName: string },
): SessionView | null {
  const id = sessionId.slice(HERMES_SESSION_PREFIX.length);
  const found = readHermesSessions(home, new Date(0)).find((each) => each.id === id);
  if (found === undefined) return null;
  const card = cardOf(found, input.now, input.agentName);
  const conversation = readHermesMessages(home, id).map((line) => ({
    at: line.at,
    who: SPOKEN[line.role] ?? SPEAKER.AGENT,
    text: line.text,
  }));
  return {
    sessionId,
    agent: HERMES,
    agentName: input.agentName,
    state: card.state,
    thinking: card.thinking,
    waitingOnYou: 0,
    helpers: [],
    steps: [],
    files: [],
    ...(card.task === undefined ? {} : { task: card.task }),
    ...(card.repository === undefined ? {} : { repository: card.repository }),
    ...(card.startedAt === undefined ? {} : { startedAt: card.startedAt }),
    ...(card.lastActive === undefined ? {} : { lastActive: card.lastActive }),
    ...(conversation.length === 0 ? {} : { conversation }),
  };
}

/** What Hermes said last in a session, whole enough to answer "what did it find". */
export function hermesLastAnswer(home: string, sessionId: string): string | null {
  const id = sessionId.slice(HERMES_SESSION_PREFIX.length);
  const said = readHermesMessages(home, id).filter((line) => line.role === 'agent');
  return said.at(-1)?.text ?? null;
}

export function isHermesSession(sessionId: string): boolean {
  return sessionId.startsWith(HERMES_SESSION_PREFIX);
}

function cardOf(session: HermesSession, now: Date, agentName: string): SessionCard {
  const recent = now.getTime() - Date.parse(session.lastActive) < WORKING_WITHIN_MS;
  return {
    sessionId: `${HERMES_SESSION_PREFIX}${session.id}`,
    agent: HERMES,
    agentName,
    state: recent ? STATE.WORKING : STATE.OPEN,
    thinking: recent,
    runningIn: 'Hermes',
    startedAt: session.startedAt,
    lastActive: session.lastActive,
    actions: session.toolCalls,
    ...(session.title === undefined ? {} : { task: session.title }),
    ...(session.directory === undefined
      ? {}
      : { repository: basename(session.directory) }),
  };
}
