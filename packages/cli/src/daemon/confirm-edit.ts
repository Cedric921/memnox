import { editedArguments, PROPOSAL_KIND, type Proposal } from '@memnox/core';

/**
 * A draft the person rewrote on its card before Send: carried out with their words in place of the
 * proposed ones. Null where nothing on that proposal is words they could have rewritten.
 */
export function editedProposal(
  proposal: Proposal,
  edited: string | undefined,
): Proposal | null {
  if (edited === undefined) return proposal;
  const change = proposal.change;
  if (change.kind !== PROPOSAL_KIND.WORK || edited.trim() === '') return null;
  const argumentsText = editedArguments(change.argumentsText, edited);
  if (argumentsText === null) return null;
  return { ...proposal, change: { ...change, argumentsText } };
}
