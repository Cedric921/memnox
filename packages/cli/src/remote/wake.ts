import type { DeviceRecord } from '@memnox/core';

/**
 * When to wake a phone: something new waits on its person and it has no tunnel open. The push
 * carries generic words only, and the phone reads the detail once it connects.
 */

/** One wake a minute per phone at most, however much arrives. */
const WAKE_SPACING_MS = 60_000;

export class PhoneWakes {
  private told = new Set<string>();
  private readonly lastWake = new Map<string, number>();

  /** The phones to wake for what waits now, given which have a live session. */
  due(
    waiting: readonly string[],
    phones: readonly DeviceRecord[],
    input: { live: (deviceId: string) => boolean; now: number },
  ): DeviceRecord[] {
    const fresh = waiting.some((subject) => !this.told.has(subject));
    this.told = new Set(waiting);
    if (!fresh) return [];
    const due = phones.filter(
      (phone) =>
        phone.revokedAt === undefined &&
        phone.mailbox !== undefined &&
        !input.live(phone.id) &&
        input.now - (this.lastWake.get(phone.id) ?? 0) >= WAKE_SPACING_MS,
    );
    for (const phone of due) this.lastWake.set(phone.id, input.now);
    return due;
  }
}
