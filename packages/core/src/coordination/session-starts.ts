import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import { shortDigest } from '../domain/digest';
import { JsonRecordDir } from '../store/json-records';

/**
 * A new agent session the person asked for out loud: which agent, in which repository, on what
 * task. It is read back first and started only on their yes, the way a spoken instruction is.
 */

export const STARTS_DIR = 'starts';

/** Long enough to hear it read back and say yes, short enough that a stale one never starts. */
export const START_TTL_MS = 5 * 60 * 1_000;

/** The agents a voice may start, each with the one command that starts it; nothing else is ever typed. */
export const STARTABLE_AGENT = {
  'claude-code': 'claude',
  codex: 'codex',
  /** Cursor's own terminal agent; the editor has no way to be handed a task from outside. */
  cursor: 'cursor-agent',
} as const;

export type StartableAgent = keyof typeof STARTABLE_AGENT;

/**
 * Where each agent's command is installed when it is not on PATH, `~` for the home folder.
 * Codex most often arrives inside the ChatGPT app, which never puts it on PATH.
 */
export const INSTALL_PLACES: Readonly<Record<StartableAgent, readonly string[]>> = {
  'claude-code': [
    '~/.claude/local/claude',
    '~/.local/bin/claude',
    '/opt/homebrew/bin/claude',
  ],
  codex: [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    '~/Applications/ChatGPT.app/Contents/Resources/codex',
    '~/.local/bin/codex',
    '/opt/homebrew/bin/codex',
  ],
  cursor: ['~/.local/bin/cursor-agent', '/opt/homebrew/bin/cursor-agent'],
};

export interface SessionStart {
  id: string;
  agent: StartableAgent;
  /** What starts it: its bare command when the shell finds it, else the full path it was found at. */
  command: string;
  /** The repository's root, checked to exist before it was ever proposed. */
  repository: string;
  task: string;
  said?: string;
  proposedAt: string;
  expiresAt: string;
}

export interface StartProposal {
  agent: StartableAgent;
  command: string;
  repository: string;
  task: string;
  said?: string;
  at: string;
}

export function isStartableAgent(agent: string): agent is StartableAgent {
  return Object.hasOwn(STARTABLE_AGENT, agent);
}

/**
 * One line, because a `cd` sent on its own reached the shell after the agent and started it at home.
 * Every value is single quoted, so a path or a task can say anything and still only be words.
 */
export function startCommand(start: SessionStart): string {
  const task = start.task.split(/\r?\n/).join(' ').trim();
  const command = BARE_COMMAND.test(start.command)
    ? start.command
    : shellQuoted(start.command);
  return `cd ${shellQuoted(start.repository)} && memnox run -- ${command} ${shellQuoted(task)}`;
}

/** A command name a shell reads as one word as it is, which a path with a space in it is not. */
const BARE_COMMAND = /^[a-z][a-z0-9-]*$/;

/** Single quoted for a POSIX shell, with each quote inside closed, escaped and reopened. */
export function shellQuoted(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export class SessionStarts {
  private readonly records: JsonRecordDir<SessionStart>;

  constructor(home: string) {
    this.records = new JsonRecordDir(join(home, MEMNOX_HOME, STARTS_DIR));
  }

  async propose(input: StartProposal): Promise<SessionStart> {
    const start: SessionStart = {
      id: `stt_${Date.parse(input.at).toString(36)}_${shortDigest(`${input.repository}${input.task}`)}`,
      agent: input.agent,
      command: input.command,
      repository: input.repository,
      task: input.task,
      ...(input.said === undefined ? {} : { said: input.said }),
      proposedAt: input.at,
      expiresAt: new Date(Date.parse(input.at) + START_TTL_MS).toISOString(),
    };
    await this.records.write(start.id, start);
    return start;
  }

  /** Taken once: a second yes to the same start finds nothing, so no session starts twice. */
  async take(id: string, moment: string): Promise<SessionStart | null> {
    const start = await this.records.read(id);
    if (start === null) return null;
    await this.records.remove(id);
    return start.expiresAt > moment ? start : null;
  }
}
