import { secondsToMs } from '@memnox/core';

// How often the sync loop runs, and what brings a pass forward.

/** Often enough that a new rule lands in a minute; an unchanged bundle is a 304. */
export const HEARTBEAT_MS = secondsToMs(60);

/** Where it backs off to while the control plane is unreachable. */
export const BACKOFF_MS = secondsToMs(15 * 60);

/**
 * How often this looks while an agent is stopped on a question. The heartbeat carries a
 * held call both ways, so a minute between passes would spend the whole hold window.
 */
const HELD_POLL_MS = secondsToMs(2);

/**
 * The soonest activity brings a pass forward. Every tool call marks it, so two seconds
 * was nine requests in ten across a fleet; a held question keeps the two second poll.
 */
const ACTIVE_PASS_MS = secondsToMs(10);

interface WaitInput {
  home: string;
  idleMs: number;
  /** When the pass began, so activity after it wakes the loop. */
  since: number;
  sleep: (ms: number) => Promise<void>;
  holding: (home: string) => Promise<number>;
  active: (home: string, since: number) => Promise<boolean>;
}

/**
 * Waits until the next pass is due, leaving early when an agent here stops on a question
 * or has done something for a while, and says how long it waited.
 */
export async function waitUntilDue(input: WaitInput): Promise<number> {
  let waited = 0;
  while (waited < input.idleMs) {
    const step = Math.min(HELD_POLL_MS, input.idleMs - waited);
    await input.sleep(step);
    waited += step;
    if ((await input.holding(input.home)) > 0) return waited;
    if (waited >= ACTIVE_PASS_MS && (await input.active(input.home, input.since))) {
      return waited;
    }
  }
  return waited;
}
