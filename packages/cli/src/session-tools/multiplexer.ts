import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { hostOf, type DeliveryProof, type HostProcess, type ShownIn } from '@memnox/core';
import { processChain } from '@memnox/interceptors';

/**
 * Typing into an agent that runs in a tmux or WezTerm pane, through the multiplexer's own command
 * line, so it reaches the right pane whichever app shows it and with no window brought forward.
 */

const MULTIPLEXER = {
  TMUX: 'tmux',
  WEZTERM: 'WezTerm',
} as const;

export type MultiplexerName = (typeof MULTIPLEXER)[keyof typeof MULTIPLEXER];

/** The pane a session's terminal is, and the program that owns it. */
export interface Pane {
  multiplexer: MultiplexerName;
  id: string;
  /** The multiplexer's program, found where it is installed, since the daemon's PATH may not have it. */
  program: string;
}

export interface PaneSeams {
  /** Runs a program with no shell; its output, or null when it is not there or failed. */
  run: (file: string, args: readonly string[]) => string | null;
  pause: (ms: number) => Promise<void>;
}

/** Where each multiplexer is installed, PATH first, then Homebrew and the app bundle. */
const PROGRAMS: Readonly<Record<MultiplexerName, readonly string[]>> = {
  tmux: ['tmux', '/opt/homebrew/bin/tmux', '/usr/local/bin/tmux'],
  WezTerm: [
    'wezterm',
    '/opt/homebrew/bin/wezterm',
    '/Applications/WezTerm.app/Contents/MacOS/wezterm',
  ],
};

/** A beat before Return, since an agent reads text and Return arriving together as a paste. */
const BEFORE_RETURN_MS = 150;
/** Long enough for an agent to take the words and draw them in its conversation. */
const BEFORE_READBACK_MS = 300;
/** Enough of the start of the words to know them again, short enough that a wrapped line still holds it. */
const READBACK_CHARS = 32;

/** The tmux or WezTerm pane on this terminal, or null when neither holds it. */
export function paneOn(tty: string, seams: PaneSeams = NODE_SEAMS): Pane | null {
  const device = basename(tty);
  for (const program of PROGRAMS.tmux) {
    const listing = seams.run(program, [
      'list-panes',
      '-a',
      '-F',
      '#{pane_tty} #{pane_id}',
    ]);
    if (listing === null) continue;
    for (const line of listing.split('\n')) {
      const [paneTty, id] = line.trim().split(' ');
      if (paneTty !== undefined && id !== undefined && basename(paneTty) === device)
        return { multiplexer: MULTIPLEXER.TMUX, id, program };
    }
    break;
  }
  for (const program of PROGRAMS.WezTerm) {
    const listing = seams.run(program, ['cli', 'list', '--format', 'json']);
    if (listing === null) continue;
    const id = weztermPane(listing, device);
    return id === null ? null : { multiplexer: MULTIPLEXER.WEZTERM, id, program };
  }
  return null;
}

function weztermPane(listing: string, device: string): string | null {
  let panes: unknown;
  try {
    panes = JSON.parse(listing);
  } catch {
    return null;
  }
  if (!Array.isArray(panes)) return null;
  for (const pane of panes as unknown[]) {
    if (typeof pane !== 'object' || pane === null) continue;
    const { tty_name: name, pane_id: id } = pane as Record<string, unknown>;
    if (typeof name === 'string' && basename(name) === device && typeof id === 'number')
      return String(id);
  }
  return null;
}

/** The words typed into the pane and sent, with what was read back when they could be seen there. */
export async function typeIntoPane(
  pane: Pane,
  text: string,
  seams: PaneSeams = NODE_SEAMS,
): Promise<{ sent: boolean; proof?: DeliveryProof }> {
  const line = text.split(/\r?\n/).join(' ');
  if (seams.run(pane.program, sendText(pane, line)) === null) return { sent: false };
  await seams.pause(BEFORE_RETURN_MS);
  if (seams.run(pane.program, sendKey(pane, 'Enter')) === null) return { sent: false };
  await seams.pause(BEFORE_READBACK_MS);
  const seen = readBack(pane, line, seams);
  return seen === null
    ? { sent: true }
    : {
        sent: true,
        proof: { checked: `the words in its ${pane.multiplexer} pane`, seen },
      };
}

/** The multiplexer a person names, as they say it, or null for anything else. */
export function multiplexerNamed(said: string): MultiplexerName | null {
  const name = said.toLowerCase().replace(/[^a-z]/g, '');
  if (name === 'tmux' || name === 'teamux') return MULTIPLEXER.TMUX;
  if (name === 'wezterm' || name === 'westerm') return MULTIPLEXER.WEZTERM;
  return null;
}

/** Where the multiplexer is installed and answering, or null when none of it is running here. */
export function runningMultiplexer(
  multiplexer: MultiplexerName,
  seams: PaneSeams = NODE_SEAMS,
): string | null {
  const asks = multiplexer === MULTIPLEXER.TMUX ? ['list-sessions'] : ['cli', 'list'];
  return (
    PROGRAMS[multiplexer].find((program) => seams.run(program, asks) !== null) ?? null
  );
}

/** A new window in the running multiplexer, opened in the folder, or null when it would not open. */
export function openPane(
  multiplexer: MultiplexerName,
  folder: string,
  seams: PaneSeams = NODE_SEAMS,
): Pane | null {
  const program = runningMultiplexer(multiplexer, seams);
  if (program === null) return null;
  const opened = seams.run(
    program,
    multiplexer === MULTIPLEXER.TMUX
      ? ['new-window', '-c', folder, '-P', '-F', '#{pane_id}']
      : ['cli', 'spawn', '--cwd', folder],
  );
  const id = opened?.trim() ?? '';
  return id === '' ? null : { multiplexer, id, program };
}

/** The pane closed, which hangs up on the agent in it as closing a terminal tab does. */
export function closePane(pane: Pane, seams: PaneSeams = NODE_SEAMS): boolean {
  return (
    seams.run(
      pane.program,
      pane.multiplexer === MULTIPLEXER.TMUX
        ? ['kill-pane', '-t', pane.id]
        : ['cli', 'kill-pane', '--pane-id', pane.id],
    ) !== null
  );
}

/**
 * The pane brought to the front inside its multiplexer, and the terminal it is seen in: the app and
 * tab running the tmux client attached to it, or WezTerm itself.
 */
export function showPane(
  pane: Pane,
  seams: PaneSeams = NODE_SEAMS,
  chainOf: (pid: number) => HostProcess[] = processChain,
): ShownIn | null {
  if (pane.multiplexer === MULTIPLEXER.WEZTERM) {
    seams.run(pane.program, ['cli', 'activate-pane', '--pane-id', pane.id]);
    return { app: 'WezTerm' };
  }
  seams.run(pane.program, ['select-window', '-t', pane.id]);
  seams.run(pane.program, ['select-pane', '-t', pane.id]);
  const session = seams
    .run(pane.program, ['display-message', '-p', '-t', pane.id, '#{session_name}'])
    ?.trim();
  const clients = (
    seams.run(pane.program, ['list-clients', '-F', '#{client_session} #{client_pid}']) ??
    ''
  )
    .split('\n')
    .map((line) => line.trim().split(' '))
    .filter((parts) => parts.length === 2);
  const client = clients.find(([name]) => name === session) ?? clients[0];
  const pid = Number(client?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const seen = hostOf(chainOf(pid));
  return seen.app === undefined ? null : seen;
}

/** Escape in the pane, as the person would press it to stop the agent there. */
export function pressEscapeIn(pane: Pane, seams: PaneSeams = NODE_SEAMS): boolean {
  return seams.run(pane.program, sendKey(pane, 'Escape')) !== null;
}

function sendText(pane: Pane, line: string): string[] {
  return pane.multiplexer === MULTIPLEXER.TMUX
    ? ['send-keys', '-t', pane.id, '-l', line]
    : ['cli', 'send-text', '--pane-id', pane.id, '--no-paste', line];
}

/** WezTerm has no key names, so each key is sent as the character the terminal reads for it. */
function sendKey(pane: Pane, key: 'Enter' | 'Escape'): string[] {
  if (pane.multiplexer === MULTIPLEXER.TMUX) return ['send-keys', '-t', pane.id, key];
  const character = key === 'Enter' ? '\r' : String.fromCharCode(27);
  return ['cli', 'send-text', '--pane-id', pane.id, '--no-paste', character];
}

/** The start of the words as the pane shows them now, or null when they cannot be seen there. */
function readBack(pane: Pane, line: string, seams: PaneSeams): string | null {
  const screen = seams.run(
    pane.program,
    pane.multiplexer === MULTIPLEXER.TMUX
      ? ['capture-pane', '-p', '-t', pane.id]
      : ['cli', 'get-text', '--pane-id', pane.id],
  );
  if (screen === null) return null;
  const wanted = squeezed(line).slice(0, READBACK_CHARS);
  return wanted !== '' && squeezed(screen).includes(wanted) ? wanted : null;
}

function squeezed(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const RUN_TIMEOUT_MS = 3_000;

const NODE_SEAMS: PaneSeams = {
  run: (file, args) => {
    try {
      return execFileSync(file, [...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: RUN_TIMEOUT_MS,
      });
    } catch {
      return null;
    }
  },
  pause: (ms) => sleep(ms),
};
