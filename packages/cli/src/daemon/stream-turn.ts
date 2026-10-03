import type { DaemonAskChunk } from '@memnox/core';
import { BRAIN_CHUNK } from '../operator/brain';
import type { BrainTurns } from './brain-turns';
import { OpeningHold } from './opening-hold';
import { SpokenFilter } from './spoken-filter';

/**
 * One turn streamed out, ended the moment the brain holds for the rest, since whatever it
 * writes after holding would be dropped anyway and the orb should listen now.
 */
export async function streamTurn(
  turns: BrainTurns,
  asked: string,
  send: (chunk: DaemonAskChunk) => void,
  unsaid: readonly string[] = [],
  wanted?: () => boolean,
): Promise<{ answered: string; ended: boolean }> {
  let held = false;
  let cut = false;
  // Set once the brain ended the conversation after speaking, so a second wording of it is never said.
  let ending = false;
  const answered: string[] = [];
  const spoken = new SpokenFilter(unsaid);
  const opening = new OpeningHold((text) => {
    answered.push(text);
    send({ kind: BRAIN_CHUNK.TEXT, text });
  });
  const each = (chunk: DaemonAskChunk): void => {
    if (held) return;
    if (chunk.kind === BRAIN_CHUNK.TEXT) {
      if (!ending) opening.push(spoken.text(chunk.text ?? ''));
      return;
    }
    opening.settle(isHold(chunk));
    if (isEnd(chunk) && answered.length > 0) ending = true;
    // A reply that asks something is waiting on its answer, so the end it called is never passed on.
    if (isEnd(chunk) && answered.join('').trim().endsWith('?')) return;
    if (chunk.kind === BRAIN_CHUNK.TOOL) spoken.tool();
    else if (!ending) opening.push(spoken.end());
    if (chunk.kind === BRAIN_CHUNK.CANCELLED) cut = true;
    send(chunk);
    if (!isHold(chunk)) return;
    held = true;
    send({ kind: BRAIN_CHUNK.DONE });
    turns.cancel();
  };
  await turns.ask(asked, each, wanted);
  return { answered: answered.join(''), ended: !held && !cut };
}

/** The brain closing the conversation, by the tool's own name whatever server prefix it carries. */
function isEnd(chunk: DaemonAskChunk): boolean {
  return (
    chunk.kind === BRAIN_CHUNK.TOOL && (chunk.tool ?? '').endsWith('end_conversation')
  );
}

/** The brain saying the person is mid thought, by the tool's own name whatever server prefix it carries. */
function isHold(chunk: DaemonAskChunk): boolean {
  return chunk.kind === BRAIN_CHUNK.TOOL && (chunk.tool ?? '').endsWith('keep_listening');
}
