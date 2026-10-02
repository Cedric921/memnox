import { AGENT_ARG, proposeTool, SAID_ARG } from './operator-args';
import { readTool, SESSION_ARG, type ToolDefinition } from './session-tools';

/**
 * The tools that act on the person's behalf beyond reading: running memnox commands, tracing,
 * scanning, watching, walking through, starting and putting back. Each reads back or proposes first.
 */
export const ACTING_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'memnox_command',
    description:
      'Run any memnox command the person asks for, like "status", "timeline --since 1h", "doctor", "mode autonomous", "freeze" or "protect --yes". What only reads runs now and its output comes back for you to sum up. What changes something is proposed and runs only after their Touch ID. "login" signs this Mac in to Memnox Cloud and "agents onboard <agent>" puts an agent under it: after Touch ID each runs on its own, with a browser page to approve and no terminal, and its end is told to you. A few never run by voice, and it says why. Run "help <command>" first when unsure of a flag. Commands that change something run with no terminal, so pass --yes to one that would otherwise stop to ask.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'the command and its flags, without "memnox", like "timeline --since 1h"',
        },
        said: SAID_ARG,
      },
    },
    // It reads at once, and anything that changes something is only proposed and waits on Touch ID.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  readTool(
    'command_output',
    'What a memnox command printed after the person confirmed it with Touch ID, by the id memnox_command returned.',
    { proposal: { type: 'string', description: 'the id memnox_command returned' } },
  ),
  {
    name: 'traces',
    description:
      'How something ran, step by step, like Logfire: Memnox answering the person (hearing them, the brain, each tool, speaking) or an agent session (each turn and action, with its decision, time and exit). Use it for "why was that slow", "what took so long", "trace that session" or "show me the trace". It draws a waterfall on their screen unless show is "false".',
    inputSchema: {
      type: 'object',
      properties: {
        session: SESSION_ARG,
        trace: {
          type: 'string',
          description: 'a trace id; the last question when nothing is named',
        },
        show: { type: 'string', description: '"false" to answer without drawing it' },
      },
    },
    // It writes a request to draw on the person's screen, which changes nothing an agent can do.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'show_agents',
    description:
      'Scan this Mac live and put every agent on the whole screen, each with its logo, its MCP servers, what else it reaches and its sessions now. Use it when they ask to scan their computer, or to list, see or show all their agents. Never for their sessions: all their sessions is show with display all. It reads and starts nothing.',
    inputSchema: { type: 'object', properties: {} },
    // It writes a request to draw on the person's screen, which changes nothing an agent can do.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'watch_for',
    description:
      'Tell the person out loud, once, when something happens in a session: "finished" when its turn ends, "tests_pass" or "tests_fail" when it next runs its tests, "stuck" when it is paused or waiting on them. Use it for "tell me when", "let me know if" and "shout when". It changes nothing an agent can do.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: AGENT_ARG,
        session: SESSION_ARG,
        for: { type: 'string', description: 'finished, tests_pass, tests_fail or stuck' },
        said: SAID_ARG,
      },
    },
    // It writes a note to speak up later, which changes nothing an agent can do.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'walk_through',
    description:
      "Walk the person through what a session changed: a card in the corner turns one page per file, showing that file's changed lines, while you say each note. Call changes first, pick the two to five files that matter, and pass one note per file: one or two spoken sentences on what that file's change does.",
    inputSchema: {
      type: 'object',
      properties: {
        agent: AGENT_ARG,
        session: SESSION_ARG,
        title: {
          type: 'string',
          description: 'the card heading, the task in a few words',
        },
        pages: {
          type: 'array',
          description: 'in the order you will say them',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'the file, as changes listed it' },
              note: { type: 'string', description: 'what you will say about it' },
            },
          },
        },
      },
    },
    // It writes a request to draw on the person's screen, which changes nothing an agent can do.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  proposeTool(
    'propose_start',
    'Start a new agent session the person asked for, like "start Claude in memnox cloud on the failing test". Nothing starts: it returns an id and the words to read back. Pass task in their words, and repository as they named it.',
    {
      agent: {
        type: 'string',
        description: 'claude-code or codex; claude-code when left out',
      },
      repository: {
        type: 'string',
        description: 'the repository as they named it, like "memnox cloud"',
      },
      task: {
        type: 'string',
        description: 'what the new session should do, in their words',
      },
      said: SAID_ARG,
    },
  ),
  {
    name: 'start_session',
    description:
      'Start a session from propose_start, only after the person said yes to it read back. A new terminal tab opens in that repository and the agent starts on the task under memnox run.',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'the id propose_start returned' },
      },
    },
    // It starts an agent the person asked for; everything that agent then does is ruled as ever.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  proposeTool(
    'propose_rewind',
    'Put a repository back to how it was before what a session just did, when the person says it broke something or asks to undo it. Nothing moves until they confirm with Touch ID; their current files are kept first. Pass undo "true" when they ask to bring back what a rewind put away.',
    {
      agent: AGENT_ARG,
      session: SESSION_ARG,
      undo: {
        type: 'string',
        description: '"true" to bring back what the last rewind put away',
      },
      said: SAID_ARG,
    },
  ),
];
