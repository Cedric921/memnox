import {
  HOUR_MS,
  LEDGER_SCAN_LIMIT,
  msToMinutes,
  PendingApprovals,
  SessionHosts,
  SessionPauses,
  SessionTasks,
  summarizeSession,
  type MemnoxEvent,
  type PendingApproval,
} from '@memnox/core';
import { withEvents } from '../event-store';
import { repositoriesOf } from './changes-tool';
import { textArg, type SessionToolDeps, type ToolArgs } from './read-tools';

/**
 * Every session on this machine lately, side by side, so "what is Claude doing" with two
 * Claude sessions open is answered by asking which one rather than by picking the newest.
 */

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
  const rows = [];
  for (const [sessionId, rowsOf] of grouped) {
    rows.push(await describe(deps, { sessionId, events: rowsOf, waiting, moment }));
  }
  return rows.sort((a, b) => b.lastActive.localeCompare(a.lastActive));
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
}

async function describe(
  deps: SessionToolDeps,
  { sessionId, events, waiting, moment }: OneSession,
): Promise<{ lastActive: string } & Record<string, unknown>> {
  const summary = summarizeSession(events);
  const task = await new SessionTasks(deps.home).read(sessionId);
  const pause = await new SessionPauses(deps.home).read(sessionId);
  const host = await new SessionHosts(deps.home).read(sessionId);
  const lastActive = summary?.ended ?? events[events.length - 1]?.at ?? '';
  return {
    session: sessionId,
    agent: summary?.agent ?? events[0]?.agent ?? 'unknown',
    ...(task === null ? {} : { task: task.statement }),
    repositories: repositoriesOf(events),
    started: summary?.started ?? events[0]?.at ?? '',
    lastActive,
    quietForMinutes: msToMinutes(moment.getTime() - Date.parse(lastActive)),
    actions: summary?.actions ?? events.length,
    filesChanged: summary?.filesChanged ?? 0,
    refused: summary?.blockedCount ?? 0,
    waitingOnYou: waiting.filter((each) => each.request.sessionId === sessionId).length,
    ...(pause === null ? {} : { paused: pause.reason }),
    ...(host?.app === undefined ? {} : { runningIn: host.app }),
  };
}
