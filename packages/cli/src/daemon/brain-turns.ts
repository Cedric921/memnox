import type { DaemonAskChunk } from '@memnox/core';
import { BRAIN_CHUNK, type Brain } from '../operator/brain';

/**
 * One warm brain for everything that asks the daemon: turns wait for each other, since one
 * brain holds one conversation, and a quiet brain's process is let go while the
 * conversation itself stays resumable.
 */
export class BrainTurns {
  private brain: Brain | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private turns: Promise<void> = Promise.resolve();
  private busy = false;

  constructor(
    private readonly start: () => Brain,
    private readonly idleMs: number,
  ) {}

  /** Queued behind any turn in flight, so two questions never interleave. */
  ask(said: string, send: (chunk: DaemonAskChunk) => void): Promise<void> {
    const turn = this.turns.then(() => this.turn(said, send));
    this.turns = turn.catch(() => undefined);
    return turn;
  }

  /** Stops the turn in flight, if there is one; the turns queued behind it still run. */
  cancel(): boolean {
    if (this.brain === null || !this.busy) return false;
    this.brain.cancel();
    return true;
  }

  close(): void {
    if (this.idle !== null) clearTimeout(this.idle);
    this.idle = null;
    this.brain?.close();
    this.brain = null;
  }

  private async turn(said: string, send: (chunk: DaemonAskChunk) => void): Promise<void> {
    if (this.idle !== null) clearTimeout(this.idle);
    const brain = this.brain ?? this.start();
    this.brain = brain;
    this.busy = true;
    try {
      for await (const chunk of brain.ask(said)) send(chunk);
    } catch (err) {
      // Said as the end of the turn, so the voice has something to say rather than silence.
      send({ kind: BRAIN_CHUNK.FAILED, text: String(err) });
    } finally {
      this.busy = false;
      this.idle = setTimeout(() => this.close(), this.idleMs);
      this.idle.unref();
    }
  }
}
