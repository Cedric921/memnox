import { unattendedCheck } from '@memnox/core';
import { readUnattended } from '../commands/unattended.command';
import { WaitingFeed } from '../daemon/waiting-feed';
import { DEFAULT_AGENT } from '../next/boundary-report';
import { changesTool, readingFor } from './changes-tool';
import { proposeAnswerTool, proposeRuleTool } from './propose-tools';
import { sessionsTool } from './sessions-tool';
import {
  decisionsTool,
  replayTool,
  statusTool,
  textArg,
  whyTool,
  type SessionToolDeps,
  type ToolArgs,
} from './read-tools';
import type { RewindSeams } from './rewind-tool';
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
    'sessions',
    'Every agent session on this machine lately, newest first: the agent, its task, the repository, how busy and how quiet it has been, what is waiting on the person and whether it is paused. When the person names an agent that has more than one session, ask which one they mean.',
    {
      agent: AGENT_ARG,
      hours: { type: 'string', description: 'how far back to look; 24 when left out' },
    },
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
  readTool(
    'changes',
    "What an agent's session changed in the code since its first write: files with lines added and removed, or the diff of one file, and the task it was given.",
    {
      agent: AGENT_ARG,
      session: SESSION_ARG,
      path: {
        type: 'string',
        description: 'one changed file, for its diff; the list of files when left out',
      },
      repository: {
        type: 'string',
        description:
          'the repository, when it cannot be found from what the session touched',
      },
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
  return readingFor(deps, textArg(args, 'agent') ?? DEFAULT_AGENT);
}

export async function callOperatorTool(
  deps: SessionToolDeps,
  seams: RewindSeams,
  name: string,
  args: ToolArgs,
): Promise<unknown> {
  switch (name) {
    case 'status':
      return statusTool(deps);
    case 'sessions':
      return sessionsTool(deps, args);
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
    case 'changes':
      return changesTool(asAgent(deps, args), seams, args);
    case 'propose_answer':
      return proposeAnswerTool(deps, args);
    case 'propose_rule':
      return proposeRuleTool(deps, args);
    default:
      return null;
  }
}

const ABOUT_OPERATOR =
  'You are the voice of Memnox, speaking with the person who runs these agents. Answer out loud: short sentences, the answer first, numbers said plainly, never a list read aloud. Read the machine through these tools before you answer, and never guess. Several sessions can be open at once, even for one agent: call sessions first, pass the session id to every other tool, and when the person could mean more than one, ask which. When the person answers a held call or asks for a rule, in whatever words, call propose_answer or propose_rule. You can never allow anything yourself: every allow waits for the person to confirm with Touch ID on the Mac, so tell them that.';

export const OPERATOR_CATALOGUE: ToolCatalogue = {
  info: { name: 'memnox-operator', version: '1' },
  tools: OPERATOR_TOOLS,
  call: callOperatorTool,
  instructions: async () => ABOUT_OPERATOR,
};
