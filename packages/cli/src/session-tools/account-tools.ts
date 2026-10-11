import { minutesToMs, PROPOSAL_KIND, Proposals, WORK_ACCOUNT_CHECK } from '@memnox/core';
import { workAccountOf } from '../sync/personal-work';
import { OPERATOR_AGENT } from './propose-tools';
import { twoWorkspaces } from './memory-tools';
import { textArg, type SessionToolDeps, type ToolArgs } from './read-tools';

/**
 * The accounts the person signed in to, by voice: which they are, signing out of one, and saying
 * one is theirs, which widens what runs without asking and so waits on Touch ID like any other yes.
 */

const CONFIRM_TTL_MS = minutesToMs(5);

const NO_SEAM =
  "This Mac cannot reach the person's own accounts. Say so in a sentence; never pretend it was done.";

/** Every account their sign ins reached, and whether each is known to be theirs. */
export async function myAccountsTool(deps: SessionToolDeps): Promise<unknown> {
  const seam = deps.personalWork;
  if (seam === undefined) return { reached: false, said: NO_SEAM };
  const [read, elsewhere, workspace] = await Promise.all([
    seam.accounts(),
    deps.personElsewhere?.() ?? false,
    deps.workspaceName?.() ?? null,
  ]);
  if (!read.ok) return { reached: false, said: read.said };
  return {
    ...(elsewhere ? { elsewhere: twoWorkspaces(workspace) } : {}),
    accounts: read.value.map((each) => ({
      toolkit: each.toolkit,
      ...workAccountOf(each),
    })),
    ...(read.value.length === 0
      ? {
          said: 'They have not signed in to any of their tools yet. Say so in a sentence.',
        }
      : read.value.some((each) => each.check !== WORK_ACCOUNT_CHECK.MATCHED)
        ? { said: NOT_TIED_YET }
        : {}),
  };
}

/** An account nothing ties to them yet is a detail, and the voice kept making it a reason not to send. */
const NOT_TIED_YET =
  'An account marked unverified or unknown reads and sends like any other: the Touch ID on their first send ties it to them. Never say it needs confirming, never offer to confirm it, and never hold anything up for it.';

/** Signs out of one tool at once, since taking access away needs nobody's fingerprint. */
export async function signOutTool(
  deps: SessionToolDeps,
  args: ToolArgs,
): Promise<unknown> {
  const toolkit = textArg(args, 'toolkit') ?? '';
  if (toolkit === '')
    return { said: 'Pass toolkit: the tool to sign out of, such as "slack".' };
  const seam = deps.personalWork;
  if (seam === undefined) return { reached: false, said: NO_SEAM };
  const out = await seam.signOut(toolkit);
  if (!out.ok) return { done: false, said: out.said };
  return out.value === 0
    ? { done: false, said: `They were not signed in to ${toolkit}. Say so.` }
    : {
        done: true,
        said: `Signed out of ${toolkit}. Nothing more is done there in their name.`,
      };
}

/** "That account is mine", written down for Touch ID, so it is matched from then on. */
export async function confirmAccountTool(
  deps: SessionToolDeps,
  args: ToolArgs,
): Promise<unknown> {
  const toolkit = textArg(args, 'toolkit') ?? '';
  if (toolkit === '')
    return { said: 'Pass toolkit: the tool whose account they say is theirs.' };
  const seam = deps.personalWork;
  if (seam === undefined) return { reached: false, said: NO_SEAM };
  const read = await seam.accounts();
  if (!read.ok) return { reached: false, said: read.said };
  const found = read.value.find((each) => each.toolkit === toolkit);
  if (found === undefined)
    return { done: false, said: `They are not signed in to ${toolkit}.` };
  if (found.check === WORK_ACCOUNT_CHECK.MATCHED) {
    return { done: true, said: 'That account is already known to be theirs.' };
  }
  const account = workAccountOf(found);
  const label = `${account.handle ?? account.name ?? 'this account'} on ${toolkit}`;
  const said = textArg(args, 'said');
  const proposal = await new Proposals(deps.home).propose({
    change: { kind: PROPOSAL_KIND.ACCOUNT, toolkit, label },
    rationale: `${label} is yours`,
    ...(said === undefined ? {} : { said }),
    proposedBy: OPERATOR_AGENT,
    at: deps.now().toISOString(),
    ttlMs: CONFIRM_TTL_MS,
  });
  return {
    proposed: proposal.id,
    said: `Read it back: ${label} is theirs. It holds once they confirm with Touch ID.`,
  };
}
