import {
  DAEMON_EVENT,
  describeHeldCall,
  PendingApprovals,
  Proposals,
  type DaemonEvent,
} from '@memnox/core';

/**
 * What is waiting on a person, read from the files other processes write, since a held
 * call may be raised by any seam and a proposal by any operator.
 */
export class WaitingFeed {
  private readonly pending: PendingApprovals;
  private readonly proposals: Proposals;

  constructor(home: string) {
    this.pending = new PendingApprovals(home);
    this.proposals = new Proposals(home);
  }

  /** Everything still answerable, held calls first because an agent is blocked on each. */
  async current(moment: string): Promise<DaemonEvent[]> {
    const held = (await this.pending.list(moment))
      .filter((each) => each.answer === undefined)
      .map((each): DaemonEvent => ({
        kind: DAEMON_EVENT.HELD,
        subject: each.id,
        agent: each.request.agent,
        summary: `${each.request.agent} wants to ${describeHeldCall(each.request)}`,
        at: each.askedAt,
        expiresAt: each.expiresAt,
      }));
    const proposed = (await this.proposals.open(moment)).map((each): DaemonEvent => ({
      kind: DAEMON_EVENT.PROPOSAL,
      subject: each.id,
      agent: each.proposedBy,
      summary: each.rationale,
      at: each.proposedAt,
      expiresAt: each.expiresAt,
    }));
    return [...held, ...proposed];
  }
}
