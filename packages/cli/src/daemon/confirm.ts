import { basename, isAbsolute } from 'node:path';
import {
  SessionPauses,
  ConfirmKeys,
  HOLD_ANSWER,
  Milestones,
  NodeGit,
  NodeWorktree,
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
import { registerPolicyFile } from '../policy-registry';
import { recordAnswer } from './record-answer';
import {
  commandResults,
  runMemnox,
  runsInBackground,
  VOICE_RUN,
  voiceArguments,
  type CommandRun,
} from '../session-tools/voice-commands';

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
  /** How a confirmed memnox command is run; memnox itself unless a test hands in another. */
  run?: CommandRunner;
}

/** A confirmed command still running on its own, such as a login waiting on its browser page. */
const STARTED = 'started';

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

  const approvals = new PendingApprovals(home);
  const held = await approvals.read(input.subject);
  const by = refusing ? BY_VOICE : BY_TOUCH_ID;
  const outcome = await approvals.answer(input.subject, answer, by, input.at);
  if (outcome === null || held === null)
    return { ok: false, error: `${input.subject} is no longer held` };
  if ('alreadyAnswered' in outcome) {
    return {
      ok: true,
      outcome: `already answered ${outcome.alreadyAnswered.answer ?? ''}`,
    };
  }
  await recordAnswer(home, { request: held.request, answer, by, at: input.at });
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
  return apply(home, outcome.answered, input.at, input.run ?? runMemnox);
}

async function apply(
  home: string,
  proposal: Proposal,
  at: string,
  run: CommandRunner,
): Promise<ConfirmResult> {
  const change = proposal.change;
  if (change.kind === PROPOSAL_KIND.RULES) {
    await mergeRules(change.file, change.rules, home);
    // Every seam loads only registered files, so a rule written anywhere else would be in force nowhere.
    await registerPolicyFile(home, change.file);
    return { ok: true, outcome: PROPOSAL_ANSWER.CONFIRMED };
  }
  if (change.kind === PROPOSAL_KIND.RESUME) {
    const lifted = await new SessionPauses(home).resume(
      change.sessionId,
      BY_TOUCH_ID,
      at,
    );
    return lifted === null
      ? { ok: false, error: `${change.sessionId} is not paused` }
      : { ok: true, outcome: PROPOSAL_ANSWER.CONFIRMED };
  }
  if (change.kind === PROPOSAL_KIND.REWIND) return applyRewind(change, at);
  if (change.kind === PROPOSAL_KIND.COMMAND) {
    return applyCommand(home, { id: proposal.id, argv: change.argv, at }, run);
  }
  return applyHeldAnswer(home, proposal, change, at);
}

/** The tree put back once the person signed for it; the tree as it was is kept first, so it can come back. */
async function applyRewind(
  change: { repository: string; milestone: string },
  at: string,
): Promise<ConfirmResult> {
  const milestones = new Milestones(
    new NodeGit(change.repository),
    new NodeWorktree(change.repository),
  );
  try {
    const { restored, kept } = await milestones.restore(change.milestone, at);
    return {
      ok: true,
      outcome: `${PROPOSAL_ANSWER.CONFIRMED}: back to ${restored.id}, the work before it kept as ${kept.id}`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A held call let through once the person signed for it, and the row that says who and in what words. */
async function applyHeldAnswer(
  home: string,
  proposal: Proposal,
  change: { pendingId: string; answer: HoldAnswer },
  at: string,
): Promise<ConfirmResult> {
  const approvals = new PendingApprovals(home);
  const held = await approvals.read(change.pendingId);
  const outcome = await approvals.answer(
    change.pendingId,
    change.answer,
    BY_TOUCH_ID,
    at,
  );
  if (outcome === null || held === null)
    return { ok: false, error: `${change.pendingId} is no longer held` };
  if ('answered' in outcome) {
    await recordAnswer(home, {
      request: held.request,
      answer: change.answer,
      by: BY_TOUCH_ID,
      ...(proposal.said === undefined ? {} : { said: proposal.said }),
      at,
    });
  }
  return { ok: true, outcome: PROPOSAL_ANSWER.CONFIRMED };
}

type CommandRunner = (argv: readonly string[], timeoutMs: number) => Promise<CommandRun>;

/** Long enough for an update or a protect to finish, never a command left hanging. */
const COMMAND_TIMEOUT_MS = 120_000;
/** As long as an enrolment code is good for, since the wait is the person in the browser. */
const BACKGROUND_TIMEOUT_MS = 15 * 60 * 1_000;

/**
 * A memnox command the person signed for, run here and kept for the voice to read back. Checked
 * again against what a voice may run, so a proposal written by hand cannot run what the voice never may.
 */
async function applyCommand(
  home: string,
  signed: { id: string; argv: readonly string[]; at: string },
  run: CommandRunner,
): Promise<ConfirmResult> {
  const { id, argv, at } = signed;
  const command = voiceArguments(argv);
  const results = commandResults(home);
  if (command === null || command.run === VOICE_RUN.NEVER) {
    const error = `memnox ${argv[0] ?? ''} is not something a voice may run`;
    // Kept as its result, so the voice says it failed rather than that it is still waiting.
    await results.write(id, { exitCode: 1, output: error, argv: [...argv], at });
    return { ok: false, error };
  }
  if (runsInBackground(command.argv)) {
    await results.write(id, {
      exitCode: 0,
      output: '',
      argv: command.argv,
      at,
      running: true,
    });
    // Not awaited: the confirmation ends now and the notice watcher tells the person when it does.
    void run(command.argv, BACKGROUND_TIMEOUT_MS).then((ran) =>
      results.write(id, {
        ...ran,
        argv: command.argv,
        at,
        doneAt: new Date().toISOString(),
      }),
    );
    // Started rather than done, so the Mac never says it is done while a browser page still waits.
    return { ok: true, outcome: STARTED };
  }
  const ran = await run(command.argv, COMMAND_TIMEOUT_MS);
  await results.write(id, { ...ran, argv: command.argv, at });
  return ran.exitCode === 0
    ? { ok: true, outcome: PROPOSAL_ANSWER.CONFIRMED }
    : { ok: false, error: `memnox ${argv[0] ?? ''} ended with exit ${ran.exitCode}` };
}

/** A model wrote the path, so a confirmed proposal may only ever touch the rule file itself. */
function writesOnlyAPolicyFile(proposal: Proposal): boolean {
  if (proposal.change.kind !== PROPOSAL_KIND.RULES) return true;
  // Relative to where the daemon runs would be a file nobody meant, so only a full path is written.
  return (
    isAbsolute(proposal.change.file) &&
    basename(proposal.change.file) === WRITTEN_POLICY_FILE
  );
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
