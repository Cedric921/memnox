import { basename } from 'node:path';
import {
  AGENT_ID_PREFIX,
  DAEMON_EVENT,
  LEDGER_SCAN_LIMIT,
  LEDGER_SESSION_LIMIT,
  NOTICE_KIND,
  noticesFrom,
  PendingApprovals,
  SessionHosts,
  SessionPauses,
  SessionTasks,
  SessionTurns,
  SessionWatches,
  startWatch,
  watchFired,
  type DaemonEvent,
  type NoticeWatch,
  type SessionNotice,
  type SessionWatch,
  type WatchFacts,
  type WatchFired,
} from '@memnox/core';
import { displayName, readNames } from '../agents/names';
import { withEvents } from '../event-store';
import { repositoriesWritten, touchesOf } from '../session-tools/session-writes';
import { readTestRuns, sessionTranscript } from './transcript';
import { commandResults, type CommandResult } from '../session-tools/voice-commands';

/**
 * Looks at the ledger for what is worth saying unasked, and keeps what it told for a while
 * so the voice can brief it in its own words. Starts from the moment the daemon did, since
 * a list of everything that happened before somebody was listening is not news.
 */

/** A few at once at most: a run of notices is a briefing nobody asked for. */
const MOST_AT_ONCE = 3;
/** Long enough for the app to ask for the brief, short enough that the map never grows. */
const KEEP_MS = 10 * 60 * 1_000;

export class NoticeWatcher {
  private watch: NoticeWatch;
  private readonly told = new Map<string, DaemonEvent>();
  /** Background commands whose end was told, kept for the daemon's life so none is told twice. */
  private readonly ended = new Set<string>();

  constructor(
    private readonly home: string,
    private readonly started: string,
  ) {
    this.watch = startWatch(started);
  }

  /** New notices since the last look, as events ready to send. */
  async look(moment: string): Promise<DaemonEvent[]> {
    const since = this.watch.seen;
    const events = await withEvents(this.home, (store) =>
      store.query({ since, limit: LEDGER_SCAN_LIMIT }),
    );
    const turns = await new SessionTurns(this.home).all();
    const { watch, notices } = noticesFrom(this.watch, events, turns);
    this.watch = watch;
    const fresh = await Promise.all(
      notices.slice(-MOST_AT_ONCE).map((each) => this.eventFor(each)),
    );
    for (const [subject, event] of this.told) {
      if (Date.parse(moment) - Date.parse(event.at) > KEEP_MS) this.told.delete(subject);
    }
    const watched = await this.watched(moment);
    const finished = await this.commandsEnded(moment);
    for (const event of [...fresh, ...watched, ...finished])
      this.told.set(event.subject, event);
    return [...fresh, ...watched, ...finished];
  }

  /** A login or onboarding that ran on its own after Touch ID and has now ended, each told once. */
  private async commandsEnded(moment: string): Promise<DaemonEvent[]> {
    const events: DaemonEvent[] = [];
    for (const result of await commandResults(this.home)
      .all()
      .catch(() => [])) {
      const key = `${result.at} ${result.argv.join(' ')}`;
      if (result.doneAt === undefined || result.doneAt < this.started) continue;
      if (this.ended.has(key)) continue;
      this.ended.add(key);
      events.push({
        kind: DAEMON_EVENT.NOTICE,
        subject: `ntc_command_${Date.parse(result.at).toString(36)}`,
        agent: 'memnox',
        agentName: 'Memnox',
        notice: NOTICE_KIND.WATCHED,
        summary: commandEnding(result),
        at: moment,
      });
    }
    return events;
  }

  /** What the person asked to be told about that has now happened, each said once. */
  private async watched(moment: string): Promise<DaemonEvent[]> {
    const watches = new SessionWatches(this.home);
    const open = await watches.open(moment);
    if (open.length === 0) return [];
    const heldSessions = (await new PendingApprovals(this.home).list(moment))
      .filter((each) => each.answer === undefined)
      .map((each) => each.request.sessionId);
    const events: DaemonEvent[] = [];
    for (const watch of open) {
      const fired = watchFired(watch, await this.factsFor(watch, heldSessions));
      if (fired === null) continue;
      await watches.done(watch.id);
      events.push(await this.watchEvent(fired, moment));
    }
    return events;
  }

  private async factsFor(
    watch: SessionWatch,
    heldSessions: readonly string[],
  ): Promise<WatchFacts> {
    const [turn, pause] = await Promise.all([
      new SessionTurns(this.home).read(watch.sessionId),
      new SessionPauses(this.home).inForce(watch.sessionId),
    ]);
    const transcript = await sessionTranscript(this.home, watch.sessionId);
    return {
      ...(turn?.promptAt === undefined ? {} : { promptAt: turn.promptAt }),
      ...(turn?.endedAt === undefined ? {} : { endedAt: turn.endedAt }),
      testRuns: transcript === null ? [] : readTestRuns(transcript),
      paused: pause !== null,
      held: heldSessions.filter((each) => each === watch.sessionId).length,
    };
  }

  private async watchEvent(fired: WatchFired, moment: string): Promise<DaemonEvent> {
    const { watch } = fired;
    const base = await this.eventFor({
      kind: NOTICE_KIND.WATCHED,
      sessionId: watch.sessionId,
      agent: watch.agent,
      at: moment,
    });
    const asked = watch.said === undefined ? '' : ` They asked: "${watch.said}".`;
    return {
      ...base,
      subject: `ntc_watched_${watch.id}`,
      summary: `${base.agentName ?? watch.agent}: ${fired.what}.${asked}`,
    };
  }

  /** A notice told lately, for the voice to brief by its subject. */
  recent(subject: string): DaemonEvent | null {
    return this.told.get(subject) ?? null;
  }

  private async eventFor(notice: SessionNotice): Promise<DaemonEvent> {
    const [task, host, names, wrote] = await Promise.all([
      new SessionTasks(this.home).read(notice.sessionId),
      new SessionHosts(this.home).read(notice.sessionId),
      readNames(this.home),
      this.wroteIn(notice.sessionId),
    ]);
    // Where it last wrote beats where it was opened, since a task often names another repository.
    const place = wrote ?? host?.cwd;
    const id = notice.agent.startsWith(AGENT_ID_PREFIX)
      ? notice.agent
      : `${AGENT_ID_PREFIX}${notice.agent}`;
    const agentName = displayName(names, { id, kind: notice.agent });
    return {
      kind: DAEMON_EVENT.NOTICE,
      subject: `ntc_${notice.kind}_${notice.sessionId}_${Date.parse(notice.at).toString(36)}`,
      agent: notice.agent,
      summary: sentenceFor(agentName, notice),
      at: notice.at,
      notice: notice.kind,
      agentName,
      sessionId: notice.sessionId,
      ...(task === null ? {} : { task: task.statement }),
      ...(place === undefined ? {} : { place: basename(place) }),
    };
  }

  /** The repository the session wrote in last, from its own ledger rows. */
  private async wroteIn(sessionId: string): Promise<string | undefined> {
    const rows = await withEvents(this.home, (store) =>
      store.query({ sessionId, limit: LEDGER_SESSION_LIMIT }),
    );
    return repositoriesWritten(touchesOf(rows))[0];
  }
}

/** How a command that ran on its own ended, plainly, with the last thing it printed when it failed. */
function commandEnding(result: CommandResult): string {
  const what =
    result.argv[0] === 'login'
      ? 'Connecting this Mac to the Memnox workspace'
      : `memnox ${result.argv.slice(0, 2).join(' ')}`;
  if (result.exitCode === 0) return `${what} is done; it worked.`;
  const lines = result.output.split('\n').filter((line) => line.trim() !== '');
  const last = lines[lines.length - 1]?.trim() ?? 'it stopped';
  return `${what} did not finish. It said: "${last.slice(0, 200)}".`;
}

/** The facts as one plain sentence, said as they are when the brain cannot word them. */
function sentenceFor(agent: string, notice: SessionNotice): string {
  if (notice.kind === NOTICE_KIND.COMMITTED) return `${agent} just made a commit.`;
  if (notice.kind === NOTICE_KIND.PUSHED) {
    return `${agent} just pushed${notice.target === undefined ? '' : ` to ${notice.target}`}.`;
  }
  return `${agent} finished a turn of about ${notice.minutes ?? 0} minutes and is waiting on you.`;
}
