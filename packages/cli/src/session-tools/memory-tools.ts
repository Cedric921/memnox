/**
 * What the workspace has settled, asked from inside the session: `memory` looks through what
 * this machine last pulled, and `brief` asks the control plane about the paths an agent is
 * about to change. Both read and write nothing, and neither is consulted by any verdict.
 */
import {
  factOrigin,
  factsAbout,
  MOST_FACTS_ANSWERED,
  newestFacts,
  readWorkspaceMemoryCached,
  type WorkspaceFact,
  type WorkspaceMemory,
} from '@memnox/core';

import { textArg, type SessionToolDeps, type ToolArgs } from './read-tools';

const NOT_CONNECTED =
  'This machine holds no workspace memory: it is not connected to a workspace, or has not pulled one yet. "memnox login" connects it.';

/** Settled facts about the words or paths given, or the newest ones when none are. */
export async function memoryTool(
  deps: SessionToolDeps,
  args: ToolArgs,
): Promise<unknown> {
  await deps.refreshMemory?.();
  const memory = await readWorkspaceMemoryCached(deps.home);
  if (memory === null) return { connected: false, said: NOT_CONNECTED };
  const about = textArg(args, 'about');
  if (about === undefined) {
    return answerOf(memory, newestFacts(memory, MOST_FACTS_ANSWERED), 'the newest');
  }
  const words = about.split(/[\s,]+/);
  const found = factsAbout(memory, {
    words,
    paths: words.filter((word) => word.includes('/') || /\.\w+$/.test(word)),
  });
  if (found.length > 0 || memory.facts.length === 0) {
    return answerOf(
      memory,
      found.slice(0, MOST_FACTS_ANSWERED).map((each) => each.fact),
      about,
    );
  }
  // "Summarise our decisions" names no subject a fact holds, and answering it with nothing told a workspace with decisions it had none.
  return {
    ...answerOf(memory, newestFacts(memory, MOST_FACTS_ANSWERED), 'the newest'),
    said: `Nothing it holds names "${about}", so these are the newest of the ${memory.facts.length} it holds. Conversations and tickets are not here: look in sources before saying the workspace has nothing about it.`,
  };
}

/**
 * The live brief for the paths given, or what this machine holds about them where the
 * control plane cannot be asked, said as such so a stale answer is never read as a fresh one.
 */
export async function briefTool(deps: SessionToolDeps, args: ToolArgs): Promise<unknown> {
  const resources = (textArg(args, 'paths') ?? '')
    .split(/[\s,]+/)
    .filter((each) => each !== '');
  if (resources.length === 0) {
    return { said: 'Name the paths, services or repository you are about to change.' };
  }
  const repository = textArg(args, 'repository');
  const live = await deps.brief(resources, repository);
  if (live !== null) return { from: 'the workspace, just now', brief: live };
  const memory = await readWorkspaceMemoryCached(deps.home);
  if (memory === null) return { connected: false, said: NOT_CONNECTED };
  const found = factsAbout(memory, { paths: resources, words: resources });
  return answerOf(
    memory,
    found.slice(0, MOST_FACTS_ANSWERED).map((each) => each.fact),
    resources.join(', '),
  );
}

function answerOf(
  memory: WorkspaceMemory,
  facts: readonly WorkspaceFact[],
  about: string,
): Record<string, unknown> {
  return {
    about,
    from: `what this machine pulled from the workspace at ${memory.syncedAt}`,
    held: memory.facts.length,
    facts: facts.map(factRow),
    ...(facts.length === 0
      ? {
          said: 'The workspace has settled nothing about this. Conversations and tickets are not here: look in sources before saying the workspace has nothing about it.',
        }
      : {}),
    ...(memory.withheld > 0
      ? { withheld: `${memory.withheld} fact(s) this machine is not cleared to read` }
      : {}),
    cite: 'Quote these rather than restating them, and ask a person where the task disagrees.',
  };
}

function factRow(fact: WorkspaceFact): Record<string, unknown> {
  return {
    statement: fact.statement,
    kind: fact.kind,
    about: fact.subject,
    ...(fact.scope === undefined ? {} : { scope: fact.scope }),
    ...(fact.principal === undefined ? {} : { names: fact.principal }),
    settled: factOrigin(fact),
  };
}

/**
 * Said wherever it explains an empty answer, since nothing else would ever tell them. Either side may be the
 * stale one, so both are named with the step that moves each, rather than calling this Mac the wrong one.
 */
export function twoWorkspaces(machineWorkspace: string | null): string {
  const here = machineWorkspace ?? 'the workspace this Mac is in';
  return `This Mac is in ${here}, and their own sign in, which their accounts and tools go through, is in a different workspace. Say both plainly. When ${here} is theirs, running memnox team and approving it there moves their sign in to it; otherwise memnox login, approved in their own workspace, moves this Mac. Never say which one is wrong unless they told you.`;
}

/** The settled facts with the workspace's name, and a word when this Mac is enrolled in another one. */
export async function workspaceMemoryTool(
  deps: SessionToolDeps,
  args: ToolArgs,
): Promise<unknown> {
  const [answer, name, elsewhere] = await Promise.all([
    memoryTool(deps, args),
    deps.workspaceName?.() ?? null,
    deps.personElsewhere?.() ?? false,
  ]);
  // memoryTool always answers with an object; it is typed unknown only because tools answer anything.
  return {
    ...(name === null ? {} : { workspace: name }),
    ...(answer as object),
    ...(elsewhere ? { elsewhere: twoWorkspaces(name) } : {}),
  };
}
