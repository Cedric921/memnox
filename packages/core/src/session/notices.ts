/**
 * What is worth telling a person without being asked: a session that worked for a while and
 * has now gone quiet, and a commit or a push. Counted from the ledger and nothing else, so a
 * notice always names something that happened.
 */
import { ACTION } from '../constants/action.constants';
import { DECISION_EFFECT } from '../constants/decision.constants';
import { UNNAMED_SESSION } from '../constants/session.constants';
import type { MemnoxEvent } from '../event/event';
import type { SessionTurn } from './session-turns';

export const NOTICE_KIND = {
  /** A long turn ended and the agent handed back to the person. */
  FINISHED: 'finished',
  COMMITTED: 'committed',
  PUSHED: 'pushed',
  /** Something the person asked to be told about happened. */
  WATCHED: 'watched',
  /** Only watching, a rule would have asked about or refused something that went through. */
  WOULD_HAVE: 'would-have',
  /** An agent asked its person something in its own picker, held so the voice can read it out. */
  QUESTION: 'question',
  /** A command the voice started ran on its own and worked, which needs nobody, so it is shown and not said. */
  ENDED: 'ended',
  /** Two agents on one piece of work, here or across machines, which the person sorts out. */
  COLLISION: 'collision',
} as const;

export type NoticeKind = (typeof NOTICE_KIND)[keyof typeof NOTICE_KIND];

export interface SessionNotice {
  kind: NoticeKind;
  sessionId: string;
  agent: string;
  at: string;
  /** For a commit or a push, what it named: the branch or the remote. */
  target?: string;
  /** For a finished turn, how long it ran, which is why it is worth saying. */
  minutes?: number;
  /** For what a rule would have done: the action, the rule, and ask or deny. */
  action?: string;
  rule?: string;
  wouldHave?: string;
}

/** What has been told so far, carried from one look to the next so nothing is told twice. */
export interface NoticeWatch {
  /** The newest ledger event already counted. */
  seen: string;
  /** The newest turn ending already counted. */
  turnsSeen: string;
}

/** A turn this long is one the person likely stepped away from, so its end is news; a short one they watched. */
export const LONG_TURN_MS = 2 * 60 * 1_000;

export function startWatch(moment: string): NoticeWatch {
  return { seen: moment, turnsSeen: moment };
}

/** The new notices since the last look, and the watch to carry into the next one. */
export function noticesFrom(
  watch: NoticeWatch,
  events: readonly MemnoxEvent[],
  turns: readonly SessionTurn[],
): { watch: NoticeWatch; notices: SessionNotice[] } {
  const fresh = events
    .filter((each) => each.at > watch.seen && each.sessionId !== UNNAMED_SESSION)
    .sort((a, b) => a.at.localeCompare(b.at));
  const notices = [
    ...fresh.map(shippedNotice),
    ...onceEach(fresh.map(wouldHaveNotice)),
  ].filter((each): each is SessionNotice => each !== null);
  let turnsSeen = watch.turnsSeen;
  for (const turn of turns) {
    if (turn.endedAt === undefined || turn.endedAt <= watch.turnsSeen) continue;
    if (turn.endedAt > turnsSeen) turnsSeen = turn.endedAt;
    const finished = finishedNotice(turn);
    if (finished !== null) notices.push(finished);
  }
  return {
    watch: { seen: fresh[fresh.length - 1]?.at ?? watch.seen, turnsSeen },
    notices: notices.sort((a, b) => a.at.localeCompare(b.at)),
  };
}

/** A turn that ran long and has handed back to the person, which is the moment they want to hear. */
function finishedNotice(turn: SessionTurn): SessionNotice | null {
  if (turn.endedAt === undefined || turn.promptAt === undefined) return null;
  if (turn.promptAt > turn.endedAt) return null;
  const ran = Date.parse(turn.endedAt) - Date.parse(turn.promptAt);
  if (ran < LONG_TURN_MS) return null;
  return {
    kind: NOTICE_KIND.FINISHED,
    sessionId: turn.sessionId,
    agent: turn.agent,
    at: turn.endedAt,
    minutes: Math.round(ran / 60_000),
  };
}

/** A commit or a push that went through, which is the moment work leaves the working tree. */
function shippedNotice(event: MemnoxEvent): SessionNotice | null {
  const kind =
    event.operation === ACTION.GIT_COMMIT
      ? NOTICE_KIND.COMMITTED
      : event.operation === ACTION.GIT_PUSH
        ? NOTICE_KIND.PUSHED
        : null;
  if (kind === null || event.effect !== DECISION_EFFECT.ALLOW) return null;
  if (event.exitCode !== undefined && event.exitCode !== 0) return null;
  return {
    kind,
    sessionId: event.sessionId,
    agent: event.agent,
    at: event.at,
    ...(event.target === undefined ? {} : { target: event.target }),
  };
}

/** Something a rule the person wrote would have held, let through because Memnox is only watching. */
function wouldHaveNotice(event: MemnoxEvent): SessionNotice | null {
  const shadow = event.shadowEffect;
  if (event.effect !== DECISION_EFFECT.ALLOW || event.rule === undefined) return null;
  if (shadow !== DECISION_EFFECT.ASK && shadow !== DECISION_EFFECT.DENY) return null;
  return {
    kind: NOTICE_KIND.WOULD_HAVE,
    sessionId: event.sessionId,
    agent: event.agent,
    at: event.at,
    action: event.operation,
    rule: event.rule.name,
    wouldHave: shadow,
    ...(event.target === undefined ? {} : { target: event.target }),
  };
}

/** One per rule and session in a look, since a loop tripping the same rule is one piece of news. */
function onceEach(notices: readonly (SessionNotice | null)[]): (SessionNotice | null)[] {
  const seen = new Set<string>();
  return notices.filter((each) => {
    if (each === null) return false;
    const key = `${each.sessionId} ${each.rule ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
