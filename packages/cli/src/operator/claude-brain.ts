import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ENV_AGENT_NAME, LineBuffer, SESSION_VAR } from '@memnox/core';
import { BRAIN_CHUNK, type Brain, type BrainChunk } from './brain';
import { readStreamLine } from './claude-stream';
import { Conversations } from './conversation';

/**
 * The person's own Claude Code as the voice's brain, kept warm for a conversation. It runs
 * with every built-in tool switched off and one MCP server, so it can read the machine and
 * propose, and can never edit a file or run a command.
 */

const OPERATOR_SERVER = 'memnox-operator';

/** Whose record the brain's own session goes on, so it is never mistaken for work. */
const OPERATOR_AGENT_NAME = 'memnox-operator';

const VOICE_PROMPT =
  'You are Memnox speaking out loud. Answer in at most three short sentences, the answer first, numbers said plainly, never a list read aloud. Read the machine with the memnox-operator tools before answering and never guess. Several sessions can be open at once, even for one agent: when the person could mean more than one, ask which. You can never allow anything yourself: an allow waits for the person to confirm with Touch ID on the Mac.';

interface ClaudeBrainOptions {
  home: string;
  /** How the operator MCP server is started, which is this install's own binary. */
  operator: { command: string; args: readonly string[] };
  command?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export class ClaudeCodeBrain implements Brain {
  readonly name = 'claude';
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines = new LineQueue();
  private readonly conversations: Conversations;
  /** Set by cancel, so the process ending reads as stopped rather than as a crash. */
  private cancelled = false;

  constructor(private readonly options: ClaudeBrainOptions) {
    this.conversations = new Conversations(options.home);
  }

  async *ask(said: string): AsyncIterable<BrainChunk> {
    this.cancelled = false;
    const child = await this.started();
    child.stdin.write(`${JSON.stringify(userTurn(said))}\n`);
    let spoke = false;
    for (;;) {
      const line = await this.lines.next();
      if (line === null) {
        yield this.cancelled
          ? { kind: BRAIN_CHUNK.CANCELLED }
          : { kind: BRAIN_CHUNK.FAILED, text: 'Claude Code stopped before it answered' };
        return;
      }
      const read = readStreamLine(line, spoke);
      if (read.sessionId !== undefined) await this.keep(read.sessionId);
      for (const chunk of read.chunks) {
        if (chunk.kind === BRAIN_CHUNK.TEXT) spoke = true;
        yield chunk;
        if (chunk.kind !== BRAIN_CHUNK.TEXT && chunk.kind !== BRAIN_CHUNK.TOOL) return;
      }
    }
  }

  close(): void {
    this.child?.stdin.end();
    this.child = null;
  }

  /**
   * Ends the process rather than asking it to stop, because its conversation is saved as it
   * goes and resumes on the next ask: a half-said answer is all that is lost.
   */
  cancel(): void {
    const child = this.child;
    if (child === null) return;
    this.cancelled = true;
    child.kill('SIGTERM');
  }

  private async started(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child !== null) return this.child;
    const resume = await this.conversations.resumable(this.name, this.now());
    // A fresh queue per process, since the last one ended when its process did.
    const lines = new LineQueue();
    this.lines = lines;
    const child = spawn(
      this.options.command ?? 'claude',
      claudeArgs(this.options, resume),
      {
        env: brainEnv(this.options.env ?? process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const buffer = new LineBuffer();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const line of buffer.push(chunk)) lines.push(line);
    });
    child.on('close', () => {
      if (this.child === child) this.child = null;
      lines.end();
    });
    // A missing binary surfaces as a failed turn, since `close` follows every spawn error.
    child.on('error', () => undefined);
    this.child = child;
    return child;
  }

  private async keep(sessionId: string): Promise<void> {
    try {
      await this.conversations.keep(this.name, sessionId, this.now());
    } catch {
      // Resuming is a convenience: a home that cannot be written loses the follow up, never the answer.
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

/** The flags that make Claude Code a brain that reads and proposes and does nothing else. */
function claudeArgs(options: ClaudeBrainOptions, resume: string | null): string[] {
  const servers = {
    mcpServers: {
      [OPERATOR_SERVER]: {
        command: options.operator.command,
        args: options.operator.args,
      },
    },
  };
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Every built-in tool off: no Bash, no Edit, no Write, no web.
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify(servers),
    '--allowedTools',
    `mcp__${OPERATOR_SERVER}`,
    '--append-system-prompt',
    VOICE_PROMPT,
    ...(resume === null ? [] : ['--resume', resume]),
  ];
}

function userTurn(said: string): unknown {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: said }] },
  };
}

/** The person's own login, with the brain recorded as the operator and never as their work. */
function brainEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, [ENV_AGENT_NAME]: OPERATOR_AGENT_NAME };
  delete out[SESSION_VAR];
  return out;
}

/** Lines that outlive one turn, since the process is warm across the conversation. */
class LineQueue {
  private readonly waiting: string[] = [];
  private reader: ((line: string | null) => void) | null = null;
  private ended = false;

  push(line: string): void {
    if (this.reader === null) {
      this.waiting.push(line);
      return;
    }
    const read = this.reader;
    this.reader = null;
    read(line);
  }

  end(): void {
    this.ended = true;
    this.reader?.(null);
    this.reader = null;
  }

  next(): Promise<string | null> {
    const line = this.waiting.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.reader = resolve;
    });
  }
}
