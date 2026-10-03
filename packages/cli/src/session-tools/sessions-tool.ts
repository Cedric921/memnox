import {
  describeHost,
  HOUR_MS,
  LEDGER_SCAN_LIMIT,
  msToMinutes,
  PendingApprovals,
  SessionHosts,
  SessionPauses,
  SessionSubagents,
  SessionTasks,
  SessionTurns,
  summarizeSubagents,
  type SessionTurn,
  summarizeSession,
  UNNAMED_AGENT,
  UNNAMED_SESSION,
  type MemnoxEvent,
  type PendingApproval,
  type SessionHost,
} from '@memnox/core';
import { withEvents } from '../event-store';
import { repositoriesOf } from './changes-tool';
import { textArg, type SessionToolDeps, type ToolArgs } from './read-tools';

/**
 * Every session on this machine lately, side by side, so "what is Claude doing" with two
 * Claude sessions open is answered by asking which one rather than by picking the newest.
 */

/** Said of the catch-all session, so a pause on an editor's git check is never told as an agent stuck. */
const LOCAL_WORK =
  'commands run on this Mac outside any agent session, such as an editor or a terminal checking git';

/** Something recorded this recently is work happening now, which is what "which one is working" means. */
const WORKING_WITHIN_MS = 3 * 60 * 1_000;
/** A turn unanswered this long is an agent that crashed or was closed, not one still thinking. */
const STALE_TURN_MS = 2 * 60 * 60 * 1_000;

const TURN = {
  /** Asked and still thinking or working through it. */
  IN_PROGRESS: 'in progress',
  /** Finished its turn and handed back, waiting on the person. */
  HANDED_BACK: 'handed back to you',
} as const;

/** Quiet this long with no live process known is a session somebody walked away from. */
const IDLE_WITHIN_MS = 15 * 60 * 1_000;

const SESSION_STATE = {
  /** Something recorded in the last few minutes. */
  WORKING: 'working',
  /** Its process is alive and nothing happened lately: open, waiting on the person. */
  OPEN: 'open',
  IDLE: 'idle',
  QUIET: 'quiet',
  /** Its process is gone, so it is over whatever the ledger says. */
  ENDED: 'ended',
  PAUSED: 'paused',
} as const;

type SessionState = (typeof SESSION_STATE)[keyof typeof SESSION_STATE];

interface StateFacts {
  paused: boolean;
  quietMs: number;
  /** Thinking through a turn, or a helper of its working, though the ledger is quiet. */
  busy: boolean;
  /** Finished its turn and handed back, which beats a burst of activity just before it. */
  handedBack: boolean;
  pid?: number;
}

/** Where a session stands right now, from the pause, how long it has been quiet, and its process. */
function stateOf(facts: StateFacts): SessionState {
  if (facts.paused) return SESSION_STATE.PAUSED;
  const alive = facts.pid === undefined ? null : processAlive(facts.pid);
  if (alive === false) return SESSION_STATE.ENDED;
  if (facts.busy) return SESSION_STATE.WORKING;
  // It said it was done, so it is waiting on the person however recently it last acted.
  if (facts.handedBack) return SESSION_STATE.OPEN;
  if (facts.quietMs < WORKING_WITHIN_MS) return SESSION_STATE.WORKING;
  if (alive === true) return SESSION_STATE.OPEN;
  return facts.quietMs < IDLE_WITHIN_MS ? SESSION_STATE.IDLE : SESSION_STATE.QUIET;
}

/** Signal zero asks whether the process exists without touching it. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Somebody else's process is still a process.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Far enough back to cover a working day, since a session left running overnight still counts. */
const DEFAULT_HOURS = 24;

export async function sessionsTool(
  deps: SessionToolDeps,
  args: ToolArgs,
): Promise<unknown> {
  const hours = Number(textArg(args, 'hours') ?? DEFAULT_HOURS);
  const moment = deps.now();
  const since = new Date(
    moment.getTime() - (Number.isFinite(hours) ? hours : DEFAULT_HOURS) * HOUR_MS,
  );
  const events = await withEvents(deps.home, (store) =>
    store.query({ since: since.toISOString(), limit: LEDGER_SCAN_LIMIT }),
  );
  const agent = textArg(args, 'agent');
  const grouped = bySession(
    agent === undefined ? events : events.filter((each) => each.agent === agent),
  );
  const waiting = await new PendingApprovals(deps.home).list(moment.toISOString());
  const turns = await turnsWithThinking(deps.home, grouped, agent, moment);
  await addJustOpened(deps.home, grouped, agent, since.toISOString());
  const rows = [];
  for (const [sessionId, rowsOf] of grouped) {
    const turn = turns.get(sessionId);
    rows.push(
      await describe(deps, {
        sessionId,
        events: rowsOf,
        waiting,
        moment,
        ...(turn === undefined ? {} : { turn }),
      }),
    );
  }
  // Work happening now first, so "which one is working" reads off the top.
  return rows.sort(
    (a, b) =>
      Number(b.state === SESSION_STATE.WORKING) -
        Number(a.state === SESSION_STATE.WORKING) ||
      b.lastActive.localeCompare(a.lastActive),
  );
}

function bySession(events: readonly MemnoxEvent[]): Map<string, MemnoxEvent[]> {
  const grouped = new Map<string, MemnoxEvent[]>();
  for (const event of events) {
    const rows = grouped.get(event.sessionId) ?? [];
    rows.push(event);
    grouped.set(event.sessionId, rows);
  }
  return grouped;
}

interface OneSession {
  sessionId: string;
  events: readonly MemnoxEvent[];
  waiting: readonly PendingApproval[];
  moment: Date;
  turn?: SessionTurn;
}

async function describe(
  deps: SessionToolDeps,
  { sessionId, events, waiting, moment, turn }: OneSession,
): Promise<{ lastActive: string; state: SessionState } & Record<string, unknown>> {
  const summary = summarizeSession(events);
  const [task, pause, host, helpers] = await Promise.all([
    new SessionTasks(deps.home).read(sessionId),
    new SessionPauses(deps.home).inForce(sessionId),
    new SessionHosts(deps.home).read(sessionId),
    new SessionSubagents(deps.home).of(sessionId),
  ]);
  const last = events[events.length - 1]?.at;
  const activeAt = latestOf([summary?.ended, last, turn?.promptAt, turn?.endedAt]);
  // Being opened is not work, so it dates the session without making it look busy.
  const lastActive = activeAt === '' ? (host?.seenAt ?? '') : activeAt;
  const subagents = summarizeSubagents(helpers, moment);
  const thinking = turn !== undefined && turnInProgress(turn, moment);
  const quietMs = activeAt === '' ? Infinity : moment.getTime() - Date.parse(activeAt);
  const busy = thinking || subagents.working.length > 0;
  const pid = host === null ? {} : { pid: host.pid };
  return {
    session: sessionId,
    agent: namedAgent(events) ?? summary?.agent ?? turn?.agent ?? 'unknown',
    ...(task === null ? {} : { task: task.statement }),
    repositories: repositoriesOf(events),
    started: summary?.started ?? events[0]?.at ?? turn?.promptAt ?? '',
    lastActive,
    quietForMinutes: msToMinutes(moment.getTime() - Date.parse(lastActive)),
    state: stateOf({
      paused: pause !== null,
      quietMs,
      busy,
      handedBack: turn !== undefined && !thinking && turn.endedAt !== undefined,
      ...pid,
    }),
    ...(turn === undefined
      ? {}
      : { turn: thinking ? TURN.IN_PROGRESS : TURN.HANDED_BACK }),
    ...countsOf(summary, events.length),
    waitingOnYou: waiting.filter((each) => each.request.sessionId === sessionId).length,
    ...(pause === null ? {} : { paused: pause.reason }),
    ...runningIn(host),
    ...(helpers.length === 0 ? {} : { subagents }),
    ...(sessionId === UNNAMED_SESSION ? { notAnAgent: LOCAL_WORK } : {}),
  };
}

/**
 * Each session's turn, and a row for any session thinking since its prompt, which has recorded
 * nothing yet and is still the one working.
 */
async function turnsWithThinking(
  home: string,
  grouped: Map<string, MemnoxEvent[]>,
  agent: string | undefined,
  moment: Date,
): Promise<Map<string, SessionTurn>> {
  const turns = new Map(
    (await new SessionTurns(home).all())
      .filter((each) => agent === undefined || each.agent === agent)
      .map((each) => [each.sessionId, each]),
  );
  for (const [sessionId, turn] of turns) {
    if (!grouped.has(sessionId) && turnInProgress(turn, moment))
      grouped.set(sessionId, []);
  }
  return turns;
}

/** A session opened and not yet asked anything, alive but with nothing in the ledger. */
async function addJustOpened(
  home: string,
  grouped: Map<string, MemnoxEvent[]>,
  agent: string | undefined,
  since: string,
): Promise<void> {
  for (const host of await new SessionHosts(home).all()) {
    if (grouped.has(host.sessionId) || host.seenAt < since) continue;
    if (agent !== undefined && host.agent !== agent) continue;
    if (processAlive(host.pid)) grouped.set(host.sessionId, []);
  }
}

/**
 * The agent a session's rows name. A child the agent runs, like git, can record as "an agent",
 * and a session named by its first row would then be called that for good.
 */
function namedAgent(events: readonly MemnoxEvent[]): string | undefined {
  return events.find((each) => each.agent !== UNNAMED_AGENT && each.agent !== '')?.agent;
}

/** How much it did, from the ledger's own summary of the session. */
function countsOf(
  summary: ReturnType<typeof summarizeSession>,
  rows: number,
): { actions: number; filesChanged: number; refused: number } {
  return {
    actions: summary?.actions ?? rows,
    filesChanged: summary?.filesChanged ?? 0,
    refused: summary?.blockedCount ?? 0,
  };
}

/** The newest of the moments known, so a turn still being thought through counts as activity. */
function latestOf(moments: readonly (string | undefined)[]): string {
  return (
    moments
      .filter((each): each is string => each !== undefined)
      .sort()
      .pop() ?? ''
  );
}

/** Asked and not yet answered, and asked recently enough that a crash is not mistaken for thinking. */
function turnInProgress(turn: SessionTurn, moment: Date): boolean {
  if (turn.promptAt === undefined) return false;
  if (turn.endedAt !== undefined && turn.endedAt >= turn.promptAt) return false;
  return moment.getTime() - Date.parse(turn.promptAt) < STALE_TURN_MS;
}

/**
 * The app it runs in, short enough for a button, and where in it, in words the brain can match
 * "the one in VS Code" against: a Terminal tab, an editor's terminal, or an agent's panel.
 */
function runningIn(host: SessionHost | null): { runningIn?: string; where?: string } {
  const where = host === null ? undefined : describeHost(host);
  return {
    ...(host?.app === undefined ? {} : { runningIn: host.app }),
    ...(where === undefined ? {} : { where }),
  };
}
