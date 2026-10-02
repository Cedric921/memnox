import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import { shortDigest } from '../domain/digest';
import type { Policy } from '../policy/policy';
import { JsonRecordDir } from '../store/json-records';
import type { HoldAnswer } from './hold';

/**
 * A change something other than a person suggested, written down and never applied until a
 * person confirms it. The operator's model reads everything and writes only these.
 */

export const PROPOSALS_DIR = 'proposals';

export const PROPOSAL_KIND = {
  /** Rules merged by name into a policy file. */
  RULES: 'rules',
  /** An answer to a call that is being held. */
  ANSWER: 'answer',
  /** Lifting a pause, which lets a stopped session carry on. */
  RESUME: 'resume',
  /** The working tree of a repository put back to a milestone, which keeps the tree as it was first. */
  REWIND: 'rewind',
  /** A memnox command that changes something, run once the person confirms. */
  COMMAND: 'command',
} as const;

export const PROPOSAL_ANSWER = {
  CONFIRMED: 'confirmed',
  DECLINED: 'declined',
} as const;

export type ProposalAnswer = (typeof PROPOSAL_ANSWER)[keyof typeof PROPOSAL_ANSWER];

export type ProposedChange =
  | { kind: typeof PROPOSAL_KIND.RULES; file: string; rules: readonly Policy[] }
  | { kind: typeof PROPOSAL_KIND.ANSWER; pendingId: string; answer: HoldAnswer }
  | { kind: typeof PROPOSAL_KIND.RESUME; sessionId: string }
  | {
      kind: typeof PROPOSAL_KIND.REWIND;
      repository: string;
      milestone: string;
      sessionId?: string;
    }
  | { kind: typeof PROPOSAL_KIND.COMMAND; argv: string[] };

export interface Proposal {
  id: string;
  change: ProposedChange;
  /** Why, in the words the person heard, so the confirmation is of the same thing. */
  rationale: string;
  /** What the person said out loud, when they said something, kept for the ledger row. */
  said?: string;
  proposedBy: string;
  proposedAt: string;
  expiresAt: string;
  answer?: ProposalAnswer;
  answeredAt?: string;
  answeredBy?: string;
}

export type ProposalOutcome =
  { answered: Proposal } | { alreadyAnswered: Proposal } | { expired: Proposal } | null;

export interface ProposeInput {
  change: ProposedChange;
  rationale: string;
  said?: string;
  proposedBy: string;
  at: string;
  ttlMs: number;
}

export function proposalsDirFor(home: string): string {
  return join(home, MEMNOX_HOME, PROPOSALS_DIR);
}

export function proposalIdFor(change: ProposedChange, at: string): string {
  return `prp_${Date.parse(at).toString(36)}_${shortDigest(JSON.stringify(change))}`;
}

export class Proposals {
  private readonly records: JsonRecordDir<Proposal>;

  constructor(home: string) {
    this.records = new JsonRecordDir(proposalsDirFor(home));
  }

  async propose(input: ProposeInput): Promise<Proposal> {
    const proposal: Proposal = {
      id: proposalIdFor(input.change, input.at),
      change: input.change,
      rationale: input.rationale,
      ...(input.said === undefined ? {} : { said: input.said }),
      proposedBy: input.proposedBy,
      proposedAt: input.at,
      expiresAt: new Date(Date.parse(input.at) + input.ttlMs).toISOString(),
    };
    await this.records.write(proposal.id, proposal);
    return proposal;
  }

  read(id: string): Promise<Proposal | null> {
    return this.records.read(id);
  }

  /** Only what can still be answered, oldest first, so the first one spoken is the first raised. */
  async open(moment: string): Promise<Proposal[]> {
    const found = await this.records.all();
    return found
      .filter((proposal) => proposal.answer === undefined && proposal.expiresAt > moment)
      .sort((a, b) => a.proposedAt.localeCompare(b.proposedAt));
  }

  /** First answer wins; an expired proposal is never confirmed, because the person heard an old one. */
  async answer(
    id: string,
    answer: ProposalAnswer,
    by: string,
    at: string,
  ): Promise<ProposalOutcome> {
    const proposal = await this.read(id);
    if (proposal === null) return null;
    if (proposal.answer !== undefined) return { alreadyAnswered: proposal };
    if (proposal.expiresAt <= at) return { expired: proposal };
    const answered: Proposal = { ...proposal, answer, answeredAt: at, answeredBy: by };
    await this.records.write(id, answered);
    return { answered };
  }
}
