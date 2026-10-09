import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DeliveryProof } from '@memnox/core';

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
const BEFORE_RETURN_MS = 250;
/** Long enough for an agent to take the words and draw them in its conversation. */
const BEFORE_READBACK_MS = 600;
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
