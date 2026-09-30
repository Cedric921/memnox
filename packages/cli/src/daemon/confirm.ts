import { basename } from 'node:path';
import {
  ConfirmKeys,
  HOLD_ANSWER,
  PendingApprovals,
  PROPOSAL_ANSWER,
  PROPOSAL_KIND,
  Proposals,
  verifiesConfirmation,
  type HoldAnswer,
  type Proposal,
  type ProposalAnswer,
} from '@memnox/core';
import { mergeRules, WRITTEN_POLICY_FILE } from '../protect/merge-rules';

/**
 * A person's answer arriving from the Mac app. Refusing never needs proof, since saying no
 * can do no harm; anything that lets something happen carries a signature only their
 * fingerprint could have made.
 */

interface ConfirmInput {
  subject: string;
  answer: string;
  signature?: string;
  at: string;
}

type ConfirmResult = { ok: true; outcome: string } | { ok: false; error: string };

/** Who the ledger says answered, since a refusal arrives unsigned and an allow does not. */
const BY_TOUCH_ID = 'person (Touch ID)';
const BY_VOICE = 'person (voice)';

const PENDING_PREFIX = 'apr_';
const PROPOSAL_PREFIX = 'prp_';

/** What a voice may answer a held call with. Editing a command needs a keyboard. */
const SPOKEN_HOLD_ANSWERS: readonly string[] = [
  HOLD_ANSWER.ONCE,
  HOLD_ANSWER.SESSION,
  HOLD_ANSWER.DENY,
];

export async function confirmAnswer(
  home: string,
  input: ConfirmInput,
): Promise<ConfirmResult> {
  if (input.subject.startsWith(PENDING_PREFIX)) return answerHeld(home, input);
  if (input.subject.startsWith(PROPOSAL_PREFIX)) return answerProposal(home, input);
  return { ok: false, error: `${input.subject} is neither a held call nor a proposal` };
}

async function answerHeld(home: string, input: ConfirmInput): Promise<ConfirmResult> {
  if (!SPOKEN_HOLD_ANSWERS.includes(input.answer)) {
    return { ok: false, error: `"${input.answer}" is not an answer a held call takes` };
  }
  // Narrowed by the membership check above.
  const answer = input.answer as HoldAnswer;
  const refusing = answer === HOLD_ANSWER.DENY;
  if (!refusing && !(await signed(home, input))) return unsigned();

  const outcome = await new PendingApprovals(home).answer(
    input.subject,
    answer,
    refusing ? BY_VOICE : BY_TOUCH_ID,
    input.at,
  );
  if (outcome === null) return { ok: false, error: `${input.subject} is no longer held` };
  if ('alreadyAnswered' in outcome) {
    return {
      ok: true,
      outcome: `already answered ${outcome.alreadyAnswered.answer ?? ''}`,
    };
  }
  return { ok: true, outcome: answer };
}

async function answerProposal(home: string, input: ConfirmInput): Promise<ConfirmResult> {
  const answers: readonly string[] = Object.values(PROPOSAL_ANSWER);
  if (!answers.includes(input.answer)) {
    return { ok: false, error: `"${input.answer}" is not an answer a proposal takes` };
  }
  // Narrowed by the membership check above.
  const answer = input.answer as ProposalAnswer;
  const confirming = answer === PROPOSAL_ANSWER.CONFIRMED;
  if (confirming && !(await signed(home, input))) return unsigned();

  const proposals = new Proposals(home);
  const found = await proposals.read(input.subject);
  if (found === null) return { ok: false, error: `${input.subject} was never proposed` };
  // Checked before it is marked, so a proposal aimed at another file is refused rather than half done.
  if (confirming && !writesOnlyAPolicyFile(found)) {
    return {
      ok: false,
      error: `${input.subject} names a file that is not a policy file`,
    };
  }

  const outcome = await proposals.answer(
    input.subject,
    answer,
    confirming ? BY_TOUCH_ID : BY_VOICE,
    input.at,
  );
  if (outcome === null)
    return { ok: false, error: `${input.subject} was never proposed` };
  if ('alreadyAnswered' in outcome) {
    return {
      ok: true,
      outcome: `already ${outcome.alreadyAnswered.answer ?? 'answered'}`,
    };
  }
  if ('expired' in outcome) return { ok: false, error: `${input.subject} has expired` };
  if (!confirming) return { ok: true, outcome: answer };
  return apply(home, outcome.answered, input.at);
}

async function apply(
  home: string,
  proposal: Proposal,
  at: string,
): Promise<ConfirmResult> {
  const change = proposal.change;
  if (change.kind === PROPOSAL_KIND.RULES) {
    await mergeRules(change.file, change.rules, home);
    return { ok: true, outcome: PROPOSAL_ANSWER.CONFIRMED };
  }
  const outcome = await new PendingApprovals(home).answer(
    change.pendingId,
    change.answer,
    BY_TOUCH_ID,
    at,
  );
  if (outcome === null)
    return { ok: false, error: `${change.pendingId} is no longer held` };
  return { ok: true, outcome: PROPOSAL_ANSWER.CONFIRMED };
}

/** A model wrote the path, so a confirmed proposal may only ever touch the rule file itself. */
function writesOnlyAPolicyFile(proposal: Proposal): boolean {
  if (proposal.change.kind !== PROPOSAL_KIND.RULES) return true;
  return basename(proposal.change.file) === WRITTEN_POLICY_FILE;
}

async function signed(home: string, input: ConfirmInput): Promise<boolean> {
  if (input.signature === undefined) return false;
  const key = await new ConfirmKeys(home).read();
  if (key === null) return false;
  return verifiesConfirmation(key, input.subject, input.answer, input.signature);
}

function unsigned(): ConfirmResult {
  return {
    ok: false,
    error:
      'letting something happen needs Touch ID, and this answer carries no valid signature',
  };
}
