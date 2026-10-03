/**
 * The first words of a reply, held a moment: a brain that holds for the rest of what the person
 * says often writes "I am listening" first, which would talk over them, so those are dropped.
 */

/** About a breath of streaming: long enough to see whether the brain is holding, short enough not to be heard. */
const HOLD_MS = 250;
/** Past this the reply is an answer under way, not a few words ahead of a hold. */
const MOST_HELD_CHARS = 60;

export class OpeningHold {
  private text = '';
  private holding = true;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly say: (text: string) => void,
    private readonly holdMs = HOLD_MS,
  ) {}

  push(text: string): void {
    if (text === '') return;
    if (!this.holding) return this.say(text);
    this.text += text;
    if (this.text.length >= MOST_HELD_CHARS) return this.release();
    if (this.timer === null) {
      this.timer = setTimeout(() => this.release(), this.holdMs);
      this.timer.unref();
    }
  }

  /** Says what was held, and everything after it as it comes. */
  release(): void {
    if (!this.holding) return;
    this.stop();
    const held = this.text;
    this.text = '';
    if (held !== '') this.say(held);
  }

  /** A tool started: what was held is said, unless the tool is a hold, when none of it is. */
  settle(holding: boolean): void {
    if (holding) this.drop();
    else this.release();
  }

  /** The brain held for the rest of what the person is saying, so nothing it wrote is said. */
  drop(): void {
    this.stop();
    this.text = '';
  }

  private stop(): void {
    this.holding = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
