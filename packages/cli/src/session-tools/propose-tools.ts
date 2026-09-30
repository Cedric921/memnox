import { basename, join } from 'node:path';
import {
  DECISION_EFFECT,
  HOLD_ANSWER,
  minutesToMs,
  PendingApprovals,
  PROPOSAL_KIND,
  Proposals,
  resolveAction,
  type HoldAnswer,
  type PendingApproval,
  type Policy,
} from '@memnox/core';
import { readRegisteredFiles } from '../policy-path';
import { WRITTEN_POLICY_FILE } from '../protect/merge-rules';
import { textArg, type SessionToolDeps, type ToolArgs } from './read-tools';

/**
 * What the operator may do with what a person said: write it down as a proposal. A refusal
 * of a held call is the one exception, answered at once, because saying no can do no harm.
 * Everything that lets something happen waits for Touch ID in the Mac app.
 */

/** Who the ledger names as having proposed it, so `why` says a model wrote the words. */
export const OPERATOR_AGENT = 'agt_memnox-operator';

/** Long enough to hear the question and reach for the key, short enough that nobody confirms a stale one. */
const RULE_PROPOSAL_TTL_MS = minutesToMs(5);

const SPOKEN_ANSWERS: readonly string[] = [
  HOLD_ANSWER.ONCE,
  HOLD_ANSWER.SESSION,
  HOLD_ANSWER.DENY,
];

const RULE_EFFECTS: readonly string[] = Object.values(DECISION_EFFECT);

/** A held call answered from what the person said, in whatever words they said it. */
export async function proposeAnswerTool(
  deps: SessionToolDeps,
  args: ToolArgs,
): Promise<unknown> {
  const call = textArg(args, 'call');
  const answer = textArg(args, 'answer');
  const said = textArg(args, 'said') ?? '';
  if (call === undefined || answer === undefined || !SPOKEN_ANSWERS.includes(answer)) {
    return { refused: `name the held call and one of: ${SPOKEN_ANSWERS.join(', ')}` };
  }
  const moment = deps.now().toISOString();
  const pending = await new PendingApprovals(deps.home).read(call);
  if (pending === null || pending.answer !== undefined || pending.expiresAt <= moment) {
    return { refused: `${call} is no longer waiting on anybody` };
  }
  if (answer === HOLD_ANSWER.DENY) {
    await new PendingApprovals(deps.home).answer(
      call,
      HOLD_ANSWER.DENY,
      'person (voice)',
      moment,
    );
    return {
      answered: call,
      answer,
      said: `Refused. ${pending.request.agent} has been told.`,
    };
  }
  // Narrowed by the membership check above.
  return proposeAllow(deps, pending, answer as HoldAnswer, said);
}

/** An allow is only ever written down, and never outlives the call it answers. */
async function proposeAllow(
  deps: SessionToolDeps,
  pending: PendingApproval,
  answer: HoldAnswer,
  said: string,
): Promise<unknown> {
  const moment = deps.now().toISOString();
  const proposal = await new Proposals(deps.home).propose({
    change: { kind: PROPOSAL_KIND.ANSWER, pendingId: pending.id, answer },
    rationale: said === '' ? `${answer} for ${pending.id}` : said,
    proposedBy: OPERATOR_AGENT,
    at: moment,
    ttlMs: Date.parse(pending.expiresAt) - Date.parse(moment),
  });
  return {
    proposed: proposal.id,
    said: 'Waiting for Touch ID. Nothing is allowed until the person confirms on the Mac.',
  };
}

/** A rule the person asked for, written down for them to confirm and never written to the file here. */
export async function proposeRuleTool(
  deps: SessionToolDeps,
  args: ToolArgs,
): Promise<unknown> {
  const action = textArg(args, 'action');
  const effect = textArg(args, 'effect');
  const reason = textArg(args, 'reason');
  if (action === undefined || effect === undefined || !RULE_EFFECTS.includes(effect)) {
    return { refused: `name an action and one of: ${RULE_EFFECTS.join(', ')}` };
  }
  const file = await policyFileFor(deps.home, textArg(args, 'project'));
  if (file === null) {
    return { refused: 'no project has a rule file yet, so name the project directory' };
  }
  const verb = verbOf(action, deps.env);
  // The effect was checked against the engine's own list just above.
  const rule = {
    name: `voice-${effect}-${verb.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
    description: textArg(args, 'said') ?? `asked for by voice: ${effect} ${verb}`,
    match: { actions: [verb] },
    decision: { effect, reason: reason ?? `the person asked to ${effect} ${verb}` },
  } as Policy;
  const proposal = await new Proposals(deps.home).propose({
    change: { kind: PROPOSAL_KIND.RULES, file, rules: [rule] },
    rationale: `${effect} ${verb}`,
    proposedBy: OPERATOR_AGENT,
    at: deps.now().toISOString(),
    ttlMs: RULE_PROPOSAL_TTL_MS,
  });
  return {
    proposed: proposal.id,
    rule: { name: rule.name, action: verb, effect, file },
    said: 'Waiting for Touch ID. The rule is not in force until the person confirms on the Mac.',
  };
}

/** `railway deploy` as the engine names it; an already namespaced verb as it is. */
function verbOf(action: string, env: NodeJS.ProcessEnv): string {
  if (!action.includes(' ') && action.includes('.')) return action;
  const [binary = action, ...rest] = action.split(/\s+/);
  return resolveAction(binary, rest, env).action;
}

/** The rule file of the project named, or the only one registered; never a guess between several. */
async function policyFileFor(home: string, project?: string): Promise<string | null> {
  if (project !== undefined) return join(project, WRITTEN_POLICY_FILE);
  const written = (await readRegisteredFiles(home)).filter(
    (file) => basename(file) === WRITTEN_POLICY_FILE,
  );
  return written.length === 1 ? (written[0] ?? null) : null;
}
