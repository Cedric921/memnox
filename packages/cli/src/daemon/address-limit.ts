import { minutesToMs } from '@memnox/core';
import { readAddress, readOwner } from '../operator/owner';

/**
 * How often the voice may call the person by name or title. The model is told "not in every
 * reply" and says it in every reply anyway, so once they were addressed, the name is taken out
 * of what the voice says next for a while rather than left to the model.
 */

/** How long one "sir" or name lasts before another sounds natural rather than scripted. */
const ADDRESS_GAP_MS = minutesToMs(10);

export class AddressLimit {
  private addressedAt: number | null = null;

  constructor(private readonly home: string) {}

  /** Every way the voice may address them: the title they chose and their name. */
  async names(): Promise<string[]> {
    const names = [await readAddress(this.home), await readOwner(this.home)];
    return [
      ...new Set(names.filter((each): each is string => (each ?? '').trim() !== '')),
    ];
  }

  /** The phrases to take out of the next reply, which are none once the gap has passed. */
  unsaid(names: readonly string[], moment: string): string[] {
    const recent =
      this.addressedAt !== null && Date.parse(moment) - this.addressedAt < ADDRESS_GAP_MS;
    return recent ? names.flatMap((name) => [`, ${name}`, `${name}, `]) : [];
  }

  noteSaid(answered: string, names: readonly string[], moment: string): void {
    if (names.some((name) => answered.includes(name)))
      this.addressedAt = Date.parse(moment);
  }
}
