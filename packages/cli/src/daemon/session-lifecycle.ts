import { basename } from 'node:path';
import {
  AGENT_ID_PREFIX,
  DAEMON_EVENT,
  describeHost,
  LEDGER_SESSION_LIMIT,
  NOTICE_KIND,
  noticeSubject,
  runTally,
  SessionHosts,
  SessionTasks,
  SessionTurns,
  type DaemonEvent,
  type NoticeKind,
  type SessionHost,
} from '@memnox/core';
import { displayName, readNames } from '../agents/names';
import { withEvents } from '../event-store';
import { isOperatorAgent, processAlive } from '../session-tools/sessions-tool';

/**
 * Every session as it begins and as it ends, from the note its start hook writes and the end
 * its own hook or its process going away says, so the voice knows of each without being asked.
 */

/** Whether a session was last seen running or over. */
const LIFE = { OPEN: 'open', OVER: 'over' } as const;
type Life = (typeof LIFE)[keyof typeof LIFE];

interface LifeSeams {
  alive: (pid: number) => boolean;
}

const NODE_SEAMS: LifeSeams = { alive: processAlive };

export class SessionLives {
  private readonly lives = new Map<string, Life>();

  constructor(
    private readonly home: string,
    /** Sessions noted before this were there before anybody listened, so they are known and never announced. */
    private readonly started: string,
    private readonly seams: LifeSeams = NODE_SEAMS,
  ) {}

  /** Each session that began or ended since the last look, as a notice. */
  async look(moment: string): Promise<DaemonEvent[]> {
    const hosts = (await new SessionHosts(this.home).all()).filter(
      (host) => !isOperatorAgent(host.agent),
    );
    const changed: { host: SessionHost; kind: NoticeKind }[] = [];
    for (const host of hosts) {
      const now =
        host.endedAt !== undefined || !this.seams.alive(host.pid) ? LIFE.OVER : LIFE.OPEN;
      const was = this.lives.get(host.sessionId);
      this.lives.set(host.sessionId, now);
      if (now === LIFE.OPEN && was !== LIFE.OPEN) {
        // Running before the daemon began is not news; a session resumed after it ended is.
        if (was === undefined && host.seenAt < this.started) continue;
        changed.push({ host, kind: NOTICE_KIND.STARTED });
      } else if (now === LIFE.OVER && was === LIFE.OPEN) {
        changed.push({ host, kind: await this.howItEnded(host) });
      }
    }
    return Promise.all(
      changed.map(({ host, kind }) => this.eventFor(host, kind, moment)),
    );
  }

  /** Gone mid turn when no hook said it closed and it was still working; closed otherwise. */
  private async howItEnded(host: SessionHost): Promise<NoticeKind> {
    if (host.endedAt !== undefined) return NOTICE_KIND.CLOSED;
    const turn = await new SessionTurns(this.home).read(host.sessionId);
    const working =
      turn?.promptAt !== undefined &&
      (turn.endedAt === undefined || turn.endedAt < turn.promptAt);
    return working ? NOTICE_KIND.GONE : NOTICE_KIND.CLOSED;
  }

  private async eventFor(
    host: SessionHost,
    kind: NoticeKind,
    moment: string,
  ): Promise<DaemonEvent> {
    const [task, names, rows] = await Promise.all([
      new SessionTasks(this.home).read(host.sessionId),
      readNames(this.home),
      withEvents(this.home, (store) =>
        store.query({ sessionId: host.sessionId, limit: LEDGER_SESSION_LIMIT }),
      ),
    ]);
    const id = host.agent.startsWith(AGENT_ID_PREFIX)
      ? host.agent
      : `${AGENT_ID_PREFIX}${host.agent}`;
    const agentName = displayName(names, { id, kind: host.agent });
    const place = host.cwd === undefined ? undefined : basename(host.cwd);
    const facts: Facts = {
      agentName,
      ...(place === undefined ? {} : { place }),
      ...(task?.latestAsk === undefined ? {} : { asked: task.latestAsk }),
      ...(describeHost(host) === undefined ? {} : { runningIn: describeHost(host) }),
      minutes: Math.max(
        0,
        Math.round((Date.parse(moment) - Date.parse(host.seenAt)) / 60_000),
      ),
      actions: runTally(rows, host.seenAt, moment).actions,
    };
    return {
      kind: DAEMON_EVENT.NOTICE,
      subject: noticeSubject(kind, host.sessionId, moment),
      agent: host.agent,
      agentName,
      summary: sentenceFor(kind, facts),
      at: moment,
      notice: kind,
      sessionId: host.sessionId,
      ...(task === null ? {} : { task: task.statement }),
      ...(place === undefined ? {} : { place }),
    };
  }
}

interface Facts {
  agentName: string;
  place?: string;
  asked?: string;
  runningIn?: string;
  minutes: number;
  actions: number;
}

/** The facts as one plain sentence, said as they are when the brain cannot word them. */
function sentenceFor(kind: NoticeKind, facts: Facts): string {
  const where = facts.place === undefined ? '' : ` in ${facts.place}`;
  if (kind === NOTICE_KIND.STARTED) {
    const on = facts.runningIn === undefined ? '' : `, in ${facts.runningIn}`;
    return `${facts.agentName} started a session${where}${on}.`;
  }
  const did = `${facts.actions} ${facts.actions === 1 ? 'action' : 'actions'} over ${facts.minutes} ${facts.minutes === 1 ? 'minute' : 'minutes'}`;
  if (kind === NOTICE_KIND.GONE) {
    const asked = facts.asked === undefined ? '' : ` It was working on: ${facts.asked}.`;
    return `${facts.agentName}'s session${where} stopped in the middle of a turn, since its process is gone, so that turn did not finish.${asked} It had taken ${did}.`;
  }
  return `${facts.agentName}'s session${where} ended after ${did}.`;
}
