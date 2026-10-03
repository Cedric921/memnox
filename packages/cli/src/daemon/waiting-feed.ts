import { basename } from 'node:path';
import {
  AGENT_ID_PREFIX,
  AgentQuestions,
  DAEMON_EVENT,
  describeHeldCall,
  DisplayRequests,
  plainAsk,
  PendingApprovals,
  Proposals,
  SessionHosts,
  SessionTasks,
  NOTICE_KIND,
  type AgentQuestion,
  type DaemonEvent,
  type DisplayRequest,
  type PendingApproval,
  type SessionHost,
} from '@memnox/core';
import { liveHost } from '../session-tools/live-host';
import { displayName, readNames, type AgentNames } from '../agents/names';

/**
 * What is waiting on a person, read from the files other processes write, since a held
 * call may be raised by any seam and a proposal by any operator.
 */
export class WaitingFeed {
  private readonly pending: PendingApprovals;
  private readonly proposals: Proposals;
  private readonly displays: DisplayRequests;

  constructor(private readonly home: string) {
    this.pending = new PendingApprovals(home);
    this.proposals = new Proposals(home);
    this.displays = new DisplayRequests(home);
  }

  /** What the app is told: everything waiting, then anything the person asked to see. */
  async everything(moment: string): Promise<DaemonEvent[]> {
    const shown = await Promise.all(
      (await this.displays.open(moment)).map((each) => this.displayEvent(each)),
    );
    return [...(await this.current(moment)), ...shown];
  }

  /** A window to bring forward or a card to show, with where the session runs. */
  private async displayEvent(request: DisplayRequest): Promise<DaemonEvent> {
    const recorded = await new SessionHosts(this.home).read(request.sessionId);
    // Its terminal as it is now; a session whose process has ended has no window to bring forward.
    const host = recorded === null ? null : liveHost(recorded);
    return {
      kind: DAEMON_EVENT.SHOW,
      subject: request.id,
      agent: request.agent,
      summary: request.text ?? request.title,
      at: request.requestedAt,
      expiresAt: request.expiresAt,
      display: request.display,
      title: request.title,
      sessionId: request.sessionId,
      ...(request.files === undefined ? {} : { files: request.files }),
      ...(request.excerpt === undefined ? {} : { excerpt: request.excerpt }),
      ...(request.pages === undefined ? {} : { pages: request.pages }),
      ...(request.agents === undefined ? {} : { agents: request.agents }),
      ...(request.trace === undefined ? {} : { trace: request.trace }),
      ...(host === null
        ? request.cwd === undefined
          ? {}
          : { host: { cwd: request.cwd } }
        : {
            host: {
              ...(host.app === undefined ? {} : { app: host.app }),
              ...(host.appPath === undefined ? {} : { appPath: host.appPath }),
              ...(host.tty === undefined ? {} : { tty: host.tty }),
              // Only the agent's own id: a guess opens a new conversation in the panel instead of this one.
              ...conversationOf(host),
              // The show tool resolved the checkout the person has open, which beats the agent's own folder.
              ...((request.cwd ?? host.cwd) === undefined
                ? {}
                : { cwd: request.cwd ?? host.cwd }),
            },
          }),
    };
  }

  /** Everything still answerable, held calls first because an agent is blocked on each. */
  async current(moment: string): Promise<DaemonEvent[]> {
    const names = await readNames(this.home);
    const waiting = (await this.pending.list(moment)).filter(
      (each) => each.answer === undefined,
    );
    const held = await Promise.all(waiting.map((each) => this.heldEvent(each, names)));
    const asking = await Promise.all(
      (await new AgentQuestions(this.home).open(moment)).map((each) =>
        this.questionEvent(each, names),
      ),
    );
    const proposed = (await this.proposals.open(moment)).map((each): DaemonEvent => ({
      kind: DAEMON_EVENT.PROPOSAL,
      subject: each.id,
      agent: each.proposedBy,
      summary: each.rationale,
      at: each.proposedAt,
      expiresAt: each.expiresAt,
    }));
    return [...held, ...asking, ...proposed];
  }

  /** An agent's own question, said as news so the voice reads it out and listens for the answer. */
  private async questionEvent(
    question: AgentQuestion,
    names: AgentNames,
  ): Promise<DaemonEvent> {
    const [task, host] = await Promise.all([
      new SessionTasks(this.home).read(question.sessionId),
      new SessionHosts(this.home).read(question.sessionId),
    ]);
    const agentName = nameOf(names, question.agent);
    return {
      kind: DAEMON_EVENT.NOTICE,
      notice: NOTICE_KIND.QUESTION,
      subject: question.id,
      agent: question.agent,
      agentName,
      summary: `${agentName} is asking you: ${question.questions[0]?.question ?? 'a question'}`,
      at: question.askedAt,
      expiresAt: question.expiresAt,
      sessionId: question.sessionId,
      ...(task === null ? {} : { task: task.statement }),
      ...(host?.cwd === undefined ? {} : { place: basename(host.cwd) }),
    };
  }

  /** A held call with what a person needs to hear about it: who, where, doing what, and why. */
  private async heldEvent(
    held: PendingApproval,
    names: AgentNames,
  ): Promise<DaemonEvent> {
    const { request } = held;
    const [task, host] = await Promise.all([
      new SessionTasks(this.home).read(request.sessionId),
      new SessionHosts(this.home).read(request.sessionId),
    ]);
    // The same words the session and the DM use, so a question reads alike wherever it lands.
    const plain = held.plain ?? plainAsk(request, task?.statement);
    return {
      kind: DAEMON_EVENT.HELD,
      subject: held.id,
      agent: request.agent,
      summary: `${request.agent} wants to ${describeHeldCall(request)}`,
      at: held.askedAt,
      expiresAt: held.expiresAt,
      agentName: nameOf(names, request.agent),
      what: plain.doing ?? describeHeldCall(request),
      why: plain.why,
      sessionId: request.sessionId,
      ...(task === null ? {} : { task: task.statement }),
      ...(host?.cwd === undefined ? {} : { place: basename(host.cwd) }),
    };
  }
}

/**
 * An agent's own conversation id, which is a UUID, never Memnox's own `ses_` key for it. Outside
 * `memnox run` the session is keyed by that very id, so it is the session id itself.
 */
export function conversationOf(host: Pick<SessionHost, 'sessionId' | 'agentSession'>): {
  conversation?: string;
} {
  const id = host.agentSession ?? host.sessionId;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? { conversation: id }
    : {};
}

/** The name the person gave the agent, or its product name made readable. */
function nameOf(names: AgentNames, agent: string): string {
  const id = agent.startsWith(AGENT_ID_PREFIX) ? agent : `${AGENT_ID_PREFIX}${agent}`;
  return displayName(names, { id, kind: agent });
}
