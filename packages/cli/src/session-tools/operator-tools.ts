import { unattendedCheck } from '@memnox/core';
import { traceToolCall } from '../trace/tool-span';
import { readUnattended } from '../commands/unattended.command';
import { WaitingFeed } from '../daemon/waiting-feed';
import { DEFAULT_AGENT } from '../next/boundary-report';
import { changesTool, readingFor } from './changes-tool';
import { readReach } from '../operator/vocabulary';
import { proposeInstructionTool, sendInstructionTool } from './instruct-tools';
import { proposeAnswerTool, proposeRuleTool } from './propose-tools';
import { outsideTool } from './outside-tool';
import { repositoryTool } from './repository-tool';
import { showAgentsTool } from './agents-tool';
import { commandOutputTool, memnoxCommandTool } from './command-tool';
import { tracesTool } from './traces-tool';
import { proposeRewindTool } from './rewind-proposal';
import { pauseSessionTool, proposeResumeTool } from './session-actions';
import { proposeStartTool, startSessionTool } from './start-tools';
import { walkThroughTool } from './walk-tool';
import { watchForTool } from './watch-tool';
import { sessionTool } from './session-tool';
import { showTool } from './show-tool';
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
import { ACTING_TOOLS } from './acting-tools';
import { AGENT_ARG, proposeTool, SAID_ARG } from './operator-args';
import { readTool, SESSION_ARG, type ToolDefinition } from './session-tools';

/**
 * The tools the voice's brain is given, and the one rule over them: it reads everything and
 * writes only a proposal. A person's agent CLI runs it with these tools and none of its own.
 */

export const OPERATOR_TOOLS: readonly ToolDefinition[] = [
  readTool(
    'status',
    'Where this machine stands: the mode, which agents are here, what is held, and what happened today.',
  ),
  readTool(
    'sessions',
    'Every agent session on this machine lately, working ones first: the agent, its task, the repository, its state, whether a turn is in progress, its helpers (subagents launched, working and finished), what is waiting on the person and whether it is paused. Working sessions come first; when the person did not say which, the first is the one they mean.',
    {
      agent: AGENT_ARG,
      hours: { type: 'string', description: 'how far back to look; 24 when left out' },
    },
  ),
  readTool(
    'session',
    'Everything about one session in one call: its state, task, the latest of its conversation with the person, its last steps with failures and refusals marked, its helpers and the files it changed. Use it for what a session is doing, did, said or changed, before replay or changes, which go deeper.',
    { agent: AGENT_ARG, session: SESSION_ARG },
  ),
  readTool(
    'reach',
    'What the agents on this machine can use: the agents themselves, each MCP server and which agents start it, and the CLIs Memnox watches, which any agent with a shell can run, and which of those are signed in, so an agent running them acts as the person. Answer "is Claude Code connected to Railway" from here.',
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
    'keep_listening',
    'The person has not finished: they paused mid thought, like "so I was working on the feature" or "I wanted to ask you something". Call it and write nothing at all, and the orb keeps listening for the rest instead of answering half a sentence.',
  ),
  readTool(
    'end_conversation',
    'The person is done talking for now: they said thanks, that is all, no thanks, or it is fine to an offer. Call it alongside your short last reply, and the orb closes once you have said it instead of listening on.',
  ),
  readTool(
    'repository',
    'Which branch a session\'s repository is on and the commits made there since the session started: each commit\'s short id, time, message and files. Answer "which branch", "read the commit it just made" or "what did it commit" from here. Pass repository with a folder name such as "memnox-runtime" when they name a project rather than a session.',
    {
      agent: AGENT_ARG,
      session: SESSION_ARG,
      repository: {
        type: 'string',
        description: 'a repository folder name or path, when they name a project',
      },
    },
  ),
  readTool(
    'outside',
    'What an agent\'s session reached outside this machine: each host it fetched from or searched, each MCP server and the tools it called there, and pages a browser opened, with how often, when, and how many the rules held. Destinations only; what came back is never recorded. Answer "what is it reading from" or "what services is it talking to" from here.',
    { agent: AGENT_ARG, session: SESSION_ARG },
  ),
  readTool(
    'changes',
    'What an agent\'s session changed in the code: each file with lines added and removed, or the diff of one file with its actual lines, and the task it was given. Answer "what is it changing" or "what files" from here, and pass path for the lines of one file.',
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
  {
    name: 'show',
    description:
      'Show the person a session. display "open" turns through their sessions in 3D to this one and opens a live window on it showing what it is doing now and its conversation. display "focus" turns through them the same way and then brings its own terminal tab or editor conversation forward. display "card" puts a card in the top left corner of their screen with a title and the summary text you are about to say, so they can read along. display "all" puts every session up at once, one card each, and needs no session. display "close" closes its live window and its own terminal tab, which ends the agent there; it refuses while a turn is in progress. Use open when they ask to open, see or watch a session; focus when they ask to go to it, switch to it or take them to its tab or terminal; card when they ask for a summary or what a session did; all when they ask to see all their sessions, every session or them all at once, which is never show_agents; close when they ask to close it, its tab, its window or its terminal, which is never pause_session. Only close ends anything, and only a session that has handed back.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: AGENT_ARG,
        session: SESSION_ARG,
        display: {
          type: 'string',
          description: 'open, focus, card, close or all; card when left out',
        },
        title: {
          type: 'string',
          description: 'the card heading, such as the task in a few words',
        },
        text: {
          type: 'string',
          description: 'for a card: the summary, in the same plain words you will say',
        },
      },
    },
    // It writes a request to draw on the person's screen, which changes nothing an agent can do.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'pause_session',
    description:
      'Pause a session the person asked to stop or hold: its next action waits until they resume it. It only ever holds an agent back, so it happens at once. Pass what they said. Closing a window or tab is show with display close, never this. Never pause the session marked notAnAgent.',
    inputSchema: {
      type: 'object',
      properties: { agent: AGENT_ARG, session: SESSION_ARG, said: SAID_ARG },
    },
    // It holds an agent back and lets nothing happen, the same as a refusal.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  proposeTool(
    'propose_instruction',
    'Tell an agent session to do something the person said, such as "push it" or "add a test for the cart". Nothing is sent: it returns an id and the words to read back, so a misheard instruction is caught first. Pass message as a clear instruction to the agent in the person\'s words, with misheard names fixed, like "git push" for "guitar push"; never add work they did not ask for.',
    {
      agent: AGENT_ARG,
      session: SESSION_ARG,
      message: {
        type: 'string',
        description: 'the instruction, as the agent will read it',
      },
      about: {
        type: 'string',
        description:
          'for a hand off, another session id whose changed files are added to the message, like when they say "have Codex review what Claude just changed"',
      },
      said: SAID_ARG,
    },
  ),
  {
    name: 'send_instruction',
    description:
      'Send an instruction from propose_instruction, only after the person said yes to it read back. A working session picks it up at its next step; one waiting in a terminal has it typed in; one waiting in an editor gets it in its input for the person to send.',
    inputSchema: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          description: 'the id propose_instruction returned',
        },
      },
    },
    // It passes on what the person said; what the agent then does is still ruled as ever.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  ...ACTING_TOOLS,
  proposeTool(
    'propose_resume',
    'Resume a paused session the person asked to carry on. Nothing restarts until they confirm with Touch ID on the Mac, so say that.',
    { agent: AGENT_ARG, session: SESSION_ARG, said: SAID_ARG },
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

type OperatorCall = (
  deps: SessionToolDeps,
  seams: RewindSeams,
  args: ToolArgs,
) => unknown;

const OPERATOR_CALLS: Record<string, OperatorCall> = {
  status: (deps) => statusTool(deps),
  // The Mac app sees the call in the stream and closes the orb; nothing here has anything to do.
  end_conversation: () => ({ ended: true }),
  // The Mac app sees it too and listens on for longer; the brain says nothing this turn.
  keep_listening: () => ({ listening: true }),
  sessions: (deps, _seams, args) => sessionsTool(deps, args),
  session: (deps, _seams, args) => sessionTool(asAgent(deps, args), args),
  reach: (deps) => readReach(deps.home),
  waiting: (deps) => new WaitingFeed(deps.home).current(deps.now().toISOString()),
  unattended: async (deps, _seams, args) =>
    unattendedCheck(
      await readUnattended(deps.home, deps.cwd, textArg(args, 'agent') ?? DEFAULT_AGENT),
    ),
  why: (deps, _seams, args) => whyTool(asAgent(deps, args), args),
  replay: (deps, _seams, args) => replayTool(asAgent(deps, args), args),
  decisions: (deps, _seams, args) => decisionsTool(asAgent(deps, args), args),
  outside: (deps, _seams, args) => outsideTool(asAgent(deps, args), args),
  repository: (deps, _seams, args) => repositoryTool(asAgent(deps, args), args),
  show: (deps, seams, args) => showTool(asAgent(deps, args), seams, args),
  pause_session: (deps, _seams, args) => pauseSessionTool(asAgent(deps, args), args),
  propose_resume: (deps, _seams, args) => proposeResumeTool(asAgent(deps, args), args),
  changes: (deps, seams, args) => changesTool(asAgent(deps, args), seams, args),
  propose_instruction: (deps, seams, args) =>
    proposeInstructionTool(asAgent(deps, args), args, seams),
  watch_for: (deps, _seams, args) => watchForTool(asAgent(deps, args), args),
  show_agents: (deps, _seams, args) => showAgentsTool(deps, args),
  memnox_command: (deps, _seams, args) => memnoxCommandTool(deps, args),
  traces: (deps, _seams, args) => tracesTool(deps, args),
  command_output: (deps, _seams, args) => commandOutputTool(deps, args),
  walk_through: (deps, seams, args) => walkThroughTool(asAgent(deps, args), seams, args),
  propose_start: (deps, _seams, args) => proposeStartTool(deps, args),
  start_session: (deps, _seams, args) => startSessionTool(deps, args),
  propose_rewind: (deps, seams, args) =>
    proposeRewindTool(asAgent(deps, args), seams, args),
  send_instruction: (deps, _seams, args) => sendInstructionTool(deps, args),
  propose_answer: (deps, _seams, args) => proposeAnswerTool(deps, args),
  propose_rule: (deps, _seams, args) => proposeRuleTool(deps, args),
};

export async function callOperatorTool(
  deps: SessionToolDeps,
  seams: RewindSeams,
  name: string,
  args: ToolArgs,
): Promise<unknown> {
  const call = Object.hasOwn(OPERATOR_CALLS, name) ? OPERATOR_CALLS[name] : undefined;
  if (call === undefined) return null;
  const startAt = deps.now().toISOString();
  try {
    const answer = await call(deps, seams, args);
    await traceToolCall(deps.home, {
      name,
      startAt,
      endAt: deps.now().toISOString(),
      answer,
    });
    return answer;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await traceToolCall(deps.home, {
      name,
      startAt,
      endAt: deps.now().toISOString(),
      error,
    });
    throw err;
  }
}

const ABOUT_OPERATOR =
  'You are the voice of Memnox, speaking with the person who runs these agents. Answer out loud: short sentences, the answer first, numbers said plainly, never a list read aloud. Read the machine through these tools before you answer, and never guess. What an agent changed is in changes, with the lines of one file when you pass its path; what it reached outside this machine is in outside. Several sessions can be open at once, even for one agent: call sessions first, pass the session id to every other tool, and when the person did not say which, take the most recently active and say so. When the person answers a held call or asks for a rule, in whatever words, call propose_answer or propose_rule. When they want an agent to do something, call propose_instruction, read it back, and send_instruction only after their yes. You can never allow anything yourself: every allow waits for the person to confirm with Touch ID on the Mac, so tell them that.';

export const OPERATOR_CATALOGUE: ToolCatalogue = {
  info: { name: 'memnox-operator', version: '1' },
  tools: OPERATOR_TOOLS,
  call: callOperatorTool,
  instructions: async () => ABOUT_OPERATOR,
};
