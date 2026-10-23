import {
  Clashes,
  HANDOVER_ANSWER,
  Handovers,
  minutesToMs,
  wantedPart,
  type Clash,
  type HandoverAnswer,
} from '@memnox/core';
import { answerAsk, askForLines } from '../sync/handover';
import { SAID_ARG } from './operator-args';
import type { OperatorCall } from './operator-call';
import { textArg, type SessionToolDeps, type ToolArgs } from './read-tools';
import type { ToolDefinition } from './session-tools';

/**
 * Two owners settling who writes a file, through their voices: asking the owner of another
 * machine for the lines its agent holds, and answering such an ask. Coordination between two
 * people rather than a change to any rule, so each acts at once on what the person said.
 */

/** A hold older than this is not the one the person is talking about. */
const RECENT_CLASH_MS = minutesToMs(30);

const ANSWERS: readonly string[] = Object.values(HANDOVER_ANSWER);

export const HANDOVER_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'ask_for_lines',
    description:
      'Ask the owner of another machine for the lines their agent is writing, after the person\'s own agent was held off them, which you will have just told them as a collision. Sent in the person\'s name with what they said, like "ask Ana if I can have it" or "ask him how long he needs". Their voice reads it to them at once and their answer comes back to you as news to tell. Use it as soon as the person asks for it, with no read back. Only for a hold by another machine: a hold on this machine is between the person\'s own agents.',
    inputSchema: {
      type: 'object',
      properties: {
        said: {
          type: 'string',
          description:
            'what the person wants the other owner to hear, in their words; leave out to just ask',
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'answer_ask_for_lines',
    description:
      "Answer the ask another person sent for lines the person's own agent is writing, which you will have just read to them. give hands the lines to the asker's agent on the record, so its next write goes through and the person's own agent is refused there from now on; wait asks the asker to wait some minutes; keep keeps them. Pass what the person said so the asker hears it. Do it as soon as they answer, with no read back.",
    inputSchema: {
      type: 'object',
      properties: {
        answer: { type: 'string', description: 'give, wait or keep' },
        minutes: {
          type: 'string',
          description: 'on a wait, how many minutes they asked for',
        },
        said: SAID_ARG,
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];

export const HANDOVER_CALLS: Readonly<Record<string, OperatorCall>> = {
  ask_for_lines: (deps, _seams, args) => askTool(deps, args),
  answer_ask_for_lines: (deps, _seams, args) => answerTool(deps, args),
};

async function askTool(deps: SessionToolDeps, args: ToolArgs): Promise<unknown> {
  const clash = await latestHeldElsewhere(deps);
  if (clash === null) {
    return {
      asked: false,
      said: 'No agent of theirs was held off by another machine lately, so there is nobody to ask. Say so in a sentence.',
    };
  }
  const sent = await askForLines(deps.home, clash, textArg(args, 'said'));
  return {
    asked: sent.ok,
    what: clash.what,
    said: sent.ok
      ? `Asked for ${clash.what}. Say in a few words that you asked and will tell them the answer.`
      : `${sent.said} Say that plainly, and never say you asked.`,
  };
}

async function answerTool(deps: SessionToolDeps, args: ToolArgs): Promise<unknown> {
  const answer = textArg(args, 'answer');
  if (answer === undefined || !ANSWERS.includes(answer)) {
    return {
      answered: false,
      said: 'Ask them whether to give it, ask for a wait, or keep it.',
    };
  }
  const handovers = new Handovers(deps.home);
  const moment = deps.now().toISOString();
  const ask = (await handovers.open(moment)).at(-1);
  if (ask === undefined) {
    return {
      answered: false,
      said: 'Nobody is waiting on an answer from them about their lines. Say so in a sentence.',
    };
  }
  const minutes = Number(textArg(args, 'minutes'));
  const said = textArg(args, 'said');
  const sent = await answerAsk(deps.home, ask, {
    // Checked against ANSWERS just above, which are the union's own values.
    answer: answer as HandoverAnswer,
    ...(Number.isFinite(minutes) && minutes > 0 ? { minutes } : {}),
    ...(said === undefined ? {} : { said }),
  });
  if (!sent.ok) {
    return {
      answered: false,
      said: `${sent.said} Say that plainly, and never say it was sent.`,
    };
  }
  await handovers.answered(ask, moment);
  return {
    answered: true,
    said: `Told ${ask.fromName} about ${wantedPart(ask)}. Say so in a few words.`,
  };
}

/** The newest hold on another machine's lease, which is the one the person is talking about. */
async function latestHeldElsewhere(deps: SessionToolDeps): Promise<Clash | null> {
  const now = deps.now();
  const since = new Date(now.getTime() - RECENT_CLASH_MS).toISOString();
  const recent = await new Clashes(deps.home).since(since, now.toISOString());
  return recent.filter((clash) => clash.leaseId !== undefined).at(-1) ?? null;
}
