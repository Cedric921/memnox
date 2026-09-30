import { unattendedCheck } from '@memnox/core';
import { readUnattended } from '../commands/unattended.command';
import { WaitingFeed } from '../daemon/waiting-feed';
import { DEFAULT_AGENT } from '../next/boundary-report';
import { proposeAnswerTool, proposeRuleTool } from './propose-tools';
import {
  decisionsTool,
  replayTool,
  statusTool,
  textArg,
  whyTool,
  type SessionToolDeps,
  type ToolArgs,
} from './read-tools';
import type { ToolCatalogue } from './session-server';
import { readTool, SESSION_ARG, type ToolDefinition } from './session-tools';

/**
 * The tools the voice's brain is given, and the one rule over them: it reads everything and
 * writes only a proposal. A person's agent CLI runs it with these tools and none of its own.
 */

const AGENT_ARG = {
  type: 'string',
  description: 'the agent asked about, such as "claude-code", "codex" or "cursor"',
} as const;

const SAID_ARG = {
  type: 'string',
  description:
    'what the person said, in their words, so the confirmation is of the same thing',
} as const;

/** Writes a proposal and nothing else, which a person then confirms or not. */
function proposeTool(
  name: string,
  description: string,
  properties: ToolDefinition['inputSchema']['properties'],
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  };
}

export const OPERATOR_TOOLS: readonly ToolDefinition[] = [
  readTool(
    'status',
    'Where this machine stands: the mode, which agents are here, what is held, and what happened today.',
  ),
  readTool(
    'waiting',
    'What is waiting on the person right now: held calls from agents, and proposals to confirm. Each has an id to answer with.',
  ),
  readTool(
    'unattended',
    'Whether an agent can be left running on its own, and what to settle first if not. Counts and facts, never a score.',
    { agent: AGENT_ARG },
  ),
  readTool(
    'why',
    'Why Memnox refused or asked about something an agent did: the rule, its reason and source, and what to do instead.',
    {
      agent: AGENT_ARG,
      event: {
        type: 'string',
        description: 'a ledger event id; the latest when left out',
      },
      session: SESSION_ARG,
    },
  ),
  readTool('replay', "What an agent's session did, step by step and newest last.", {
    agent: AGENT_ARG,
    session: SESSION_ARG,
  }),
  readTool(
    'decisions',
    'The rules that cover an action or a path for an agent, evaluated and run nowhere.',
    {
      agent: AGENT_ARG,
      action: {
        type: 'string',
        description: 'a command such as "railway deploy", or a verb such as "git.push"',
      },
      path: { type: 'string', description: 'a file or directory the action touches' },
    },
  ),
  proposeTool(
    'propose_answer',
    'Answer a held call with what the person said. "deny" takes effect at once. "once" and "session" wait for Touch ID on the Mac, so say that the person has to confirm.',
    {
      call: { type: 'string', description: 'the held call id, from "waiting"' },
      answer: { type: 'string', description: 'once, session or deny' },
      said: SAID_ARG,
    },
  ),
  proposeTool(
    'propose_rule',
    'Write down a rule the person asked for: allow, ask or deny an action. Nothing is in force until they confirm with Touch ID on the Mac.',
    {
      action: {
        type: 'string',
        description:
          'a command such as "railway deploy", or a verb such as "npm.publish"',
      },
      effect: { type: 'string', description: 'allow, ask or deny' },
      reason: { type: 'string', description: 'why, as the person put it' },
      project: {
        type: 'string',
        description: 'the project directory, when more than one has a rule file',
      },
      said: SAID_ARG,
    },
  ),
];

/** The same reads the session server makes, pointed at whichever agent the person named. */
function asAgent(deps: SessionToolDeps, args: ToolArgs): SessionToolDeps {
  return { ...deps, agent: textArg(args, 'agent') ?? DEFAULT_AGENT };
}

export async function callOperatorTool(
  deps: SessionToolDeps,
  name: string,
  args: ToolArgs,
): Promise<unknown> {
  switch (name) {
    case 'status':
      return statusTool(deps);
    case 'waiting':
      return new WaitingFeed(deps.home).current(deps.now().toISOString());
    case 'unattended':
      return unattendedCheck(
        await readUnattended(
          deps.home,
          deps.cwd,
          textArg(args, 'agent') ?? DEFAULT_AGENT,
        ),
      );
    case 'why':
      return whyTool(asAgent(deps, args), args);
    case 'replay':
      return replayTool(asAgent(deps, args), args);
    case 'decisions':
      return decisionsTool(asAgent(deps, args), args);
    case 'propose_answer':
      return proposeAnswerTool(deps, args);
    case 'propose_rule':
      return proposeRuleTool(deps, args);
    default:
      return null;
  }
}

const ABOUT_OPERATOR =
  'You are the voice of Memnox, speaking with the person who runs these agents. Answer out loud: short sentences, the answer first, numbers said plainly, never a list read aloud. Read the machine through these tools before you answer, and never guess. When the person answers a held call or asks for a rule, in whatever words, call propose_answer or propose_rule. You can never allow anything yourself: every allow waits for the person to confirm with Touch ID on the Mac, so tell them that.';

export const OPERATOR_CATALOGUE: ToolCatalogue = {
  info: { name: 'memnox-operator', version: '1' },
  tools: OPERATOR_TOOLS,
  call: (deps, _seams, name, args) => callOperatorTool(deps, name, args),
  instructions: async () => ABOUT_OPERATOR,
};
