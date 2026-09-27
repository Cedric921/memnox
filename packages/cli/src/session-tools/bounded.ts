/**
 * What a session tool may hand back to the agent: clipped, capped, and with anything
 * shaped like a credential masked, because the answer lands in a model's context.
 */

/** One field, long enough for a rule's reason and short enough to never carry a file. */
export const MOST_FIELD_CHARS = 300;

/** Rows in any one list: a session's last steps, the rules that matched. */
export const MOST_ROWS = 40;

/** The whole answer, as text, whatever the tool. */
export const MOST_ANSWER_CHARS = 8_000;

const MASK = '[redacted]';

/** Credential shapes the ledger should never hold, masked again here in case one slipped in. */
const SECRET_SHAPES: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(password|passwd|secret|token|api[_-]?key)(\s*[=:]\s*)\S+/gi,
];

export function masked(text: string): string {
  return SECRET_SHAPES.reduce(
    (current, shape) =>
      current.replace(shape, (_match, name: unknown, joiner: unknown) =>
        typeof name === 'string' && typeof joiner === 'string'
          ? `${name}${joiner}${MASK}`
          : MASK,
      ),
    text,
  );
}

function clippedText(text: string): string {
  const safe = masked(text);
  if (safe.length <= MOST_FIELD_CHARS) return safe;
  return `${safe.slice(0, MOST_FIELD_CHARS)}... (cut)`;
}

/** What stands first in a list that lost its oldest rows, and how many it lost. */
function leftOutNote(count: number): string {
  return `${count} earlier row(s) left out`;
}

const LEFT_OUT = /^(\d+) earlier row\(s\) left out$/;

/** Every string masked and clipped and every list capped, all the way down. */
export function bounded(value: unknown): unknown {
  if (typeof value === 'string') return clippedText(value);
  if (Array.isArray(value)) {
    const kept = value.slice(-MOST_ROWS).map(bounded);
    return value.length > MOST_ROWS
      ? [leftOutNote(value.length - MOST_ROWS), ...kept]
      : kept;
  }
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, each] of Object.entries(value)) out[key] = bounded(each);
  return out;
}

/**
 * The answer as the agent reads it: compact, because every space is paid for, and over
 * the cap it loses the oldest rows of its longest list, so it is still JSON when it arrives.
 */
export function answerText(value: unknown): string {
  const shaped = bounded(value);
  let text = JSON.stringify(shaped) ?? 'null';
  while (text.length > MOST_ANSWER_CHARS && shortenLongestList(shaped)) {
    text = JSON.stringify(shaped);
  }
  if (text.length <= MOST_ANSWER_CHARS) return text;
  // Nothing left to drop rows from, so as much as fits, still said as JSON.
  const room = MOST_ANSWER_CHARS - CUT_NOTE_ROOM;
  return JSON.stringify({
    cut: `longer than ${MOST_ANSWER_CHARS} characters`,
    start: text.slice(0, room),
  });
}

/** Room kept for the wrapper an answer too wide to shorten by rows is put in. */
const CUT_NOTE_ROOM = 200;

/** A list and the rows in it, not counting the note that says rows were left out. */
interface Shortenable {
  list: unknown[];
  dropped: number;
  rows: number;
  size: number;
}

/** Halves the longest list in the answer, oldest rows first. False when none has rows to lose. */
function shortenLongestList(root: unknown): boolean {
  let longest: Shortenable | null = null;
  for (const list of listsIn(root)) {
    const first = list[0];
    const note = typeof first === 'string' ? LEFT_OUT.exec(first) : null;
    const dropped = note === null ? 0 : Number(note[1]);
    const rows = list.length - (note === null ? 0 : 1);
    if (rows < 2) continue;
    const size = (JSON.stringify(list) ?? '').length;
    if (longest === null || size > longest.size) longest = { list, dropped, rows, size };
  }
  if (longest === null) return false;
  const lose = Math.floor(longest.rows / 2);
  const kept = longest.list.slice(longest.list.length - (longest.rows - lose));
  longest.list.splice(
    0,
    longest.list.length,
    leftOutNote(longest.dropped + lose),
    ...kept,
  );
  return true;
}

/** Every list in a bounded answer, which is a fresh tree and so safe to shorten in place. */
function listsIn(value: unknown): unknown[][] {
  if (Array.isArray(value)) return [value, ...value.flatMap(listsIn)];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(listsIn);
}
