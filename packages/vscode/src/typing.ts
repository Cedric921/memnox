import { deviceName } from './terminal-match';

/**
 * Typing a confirmed instruction into the agent in an integrated terminal. The link names only
 * a request and a terminal: the words come from the request Memnox wrote under the person's
 * own home, so a link opened by any page can type nothing that was not already said yes to.
 */

/** A request id as Memnox mints one, and nothing that could climb out of its folder. */
const REQUEST_ID = /^dsp_[a-z0-9]+_[a-f0-9]+$/;

/** What runs a coding agent, the same list the runtime checks before it asks for typing. */
const AGENT_PROGRAMS = /^(claude|node|codex|gemini|cursor-agent|aider|opencode)$/i;

/** Every link Memnox sends an editor names a request and a terminal the same way. */
interface TypeLink {
  request: string;
  tty: string;
}

/** The request and terminal a link names, or null when either is not what Memnox would send. */
export function typeLinkOf(query: string): TypeLink | null {
  const params = new URLSearchParams(query);
  const request = params.get('request');
  const tty = params.get('tty');
  if (request === null || tty === null || !REQUEST_ID.test(request)) return null;
  return /^(\/dev\/)?ttys?[0-9]+$/.test(tty) ? { request, tty } : null;
}

/** The request itself, or why it may not be acted on: only one still waiting, of this kind, for this very terminal. */
export function waitingRequest(
  record: unknown,
  tty: string,
  moment: string,
  display: 'type' | 'close',
): { request: Record<string, unknown> } | { why: string } {
  if (record === null || typeof record !== 'object') {
    return { why: 'its request is gone' };
  }
  const request = record as Record<string, unknown>;
  if (request['display'] !== display) return { why: `it is not a request to ${display}` };
  if (request['delivered'] !== undefined) return { why: 'it was already answered' };
  const expires = request['expiresAt'];
  if (typeof expires !== 'string' || expires <= moment) {
    return { why: 'it waited too long' };
  }
  const wanted = request['tty'];
  if (typeof wanted !== 'string' || deviceName(wanted) !== deviceName(tty)) {
    return { why: 'the link named a different terminal' };
  }
  return { request };
}

/** The words to type, or why not: only an instruction still waiting, for this very terminal. */
export function typableText(
  record: unknown,
  tty: string,
  moment: string,
): { text: string } | { why: string } {
  const waiting = waitingRequest(record, tty, moment, 'type');
  if ('why' in waiting) return waiting;
  const text = waiting.request['text'];
  if (typeof text !== 'string' || text.trim() === '') return { why: 'it has no words' };
  return { text: text.split(/\r?\n/).join(' ') };
}

/** Whether `ps -o stat=,comm=` shows a coding agent in front, so words never land in a bare shell. */
export function agentInFront(listing: string): boolean {
  return listing.split('\n').some((line) => {
    const [stat, ...command] = line.trim().split(/\s+/);
    const program = command.join(' ').split('/').pop() ?? '';
    return stat?.includes('+') === true && AGENT_PROGRAMS.test(program);
  });
}

/**
 * The pause after each key: quick enough that a few sentences go in within about three seconds,
 * slow enough to be watched, with a breath after punctuation, the way the Mac types elsewhere.
 */
export function keyPausesMs(text: string, jitter: () => number = Math.random): number[] {
  const base = Math.min(45, Math.max(10, 3000 / Math.max(text.length, 1)));
  return [...text].map((character) => {
    const breath = ',.?!;:'.includes(character) ? 60 : 0;
    return Math.round(base * (0.7 + 0.6 * jitter()) + breath);
  });
}
