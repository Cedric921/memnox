import {
  AgentQuestions,
  VoiceFocusStore,
  type DaemonAskChunk,
  type DaemonRequest,
} from '@memnox/core';
import type { AddressLimit } from './address-limit';
import {
  askContext,
  FINISHED_NOTE,
  momentContext,
  questionsContext,
} from './ask-context';
import type { BrainTurns } from './brain-turns';
import {
  lastAnswered,
  recallContext,
  waitingOnYes,
  type RecentExchanges,
} from './recall';
import type { SessionViews } from './session-view';
import { write, type Peer } from './socket-write';
import { OVERTAKEN_NOTE, Speculation, type GuessSeams } from './speculation';
import { streamTurn } from './stream-turn';
import { VoiceTurnTrace } from '../trace/voice-trace';

/**
 * What the person asks, answered by their own brain one chunk per line, and the guess at it
 * started while they pause. Kept apart from the rest of the voice, since this is the path whose
 * every millisecond is heard.
 */

interface AskDeps {
  home: string;
  now: () => string;
  turns: BrainTurns;
  views: SessionViews;
  exchanges: RecentExchanges;
  address: AddressLimit;
}

/** A turn the brain answered, for recall once the person has heard it. */
interface Answered {
  text: string;
  ended: boolean;
  moment: string;
  names: Awaited<ReturnType<AddressLimit['names']>>;
}

export class VoiceAsk {
  /** A guess at the answer started while they pause, adopted when the Mac sends the same words. */
  private readonly speculation: Speculation<Answered | undefined>;

  constructor(private readonly deps: AskDeps) {
    this.speculation = new Speculation(() => deps.turns.cancel());
  }

  async ask(socket: Peer, request: DaemonRequest, said: string): Promise<void> {
    if (request.speculative === true) {
      // Answered at once: nothing of a guess is said on this request, only on the ask that adopts it.
      write(socket, { id: request.id, ok: true, outcome: 'guessing' });
      this.speculation.start(said, (seams) => this.turn(said, false, seams));
      return;
    }
    const forward = (chunk: DaemonAskChunk): void => {
      write(socket, { id: request.id, ok: true, chunk });
    };
    const finished = request.finished === true;
    // Words sent after a hold carry a note a guess never had, so no guess is ever them.
    if (finished) this.speculation.drop();
    const guessed = finished ? null : await this.speculation.adopt(said, forward);
    if (guessed !== null) return this.keep(said, guessed.answer);
    const overtaken = this.speculation.takeOvertaken();
    const seams = { send: forward, wanted: () => true };
    await this.keep(said, await this.turn(said, finished, seams, overtaken));
  }

  /** What was said and answered, kept for recall, once the person has heard it. */
  private async keep(said: string, answered: Answered | undefined): Promise<void> {
    if (answered === undefined) return;
    this.deps.address.noteSaid(answered.text, answered.names, this.deps.now());
    // Held or talked over, the words come again whole, so only the turn that ends is one.
    if (answered.ended)
      await this.deps.exchanges.add({
        at: answered.moment,
        said,
        answered: answered.text,
      });
  }

  /**
   * One question to the brain, with the sessions put in front of it. A guess runs the same way
   * and only differs in where its chunks go, so an adopted guess is the answer it would have been.
   */
  private async turn(
    said: string,
    finished: boolean,
    seams: GuessSeams,
    overtaken = false,
  ): Promise<Answered | undefined> {
    const { home, now, address } = this.deps;
    const trace = new VoiceTurnTrace(home, now, said.split(/\s+/).length);
    const moment = now();
    // Best effort: without it the brain looks the sessions up itself, only slower.
    const { context, sessions } = await this.contextFor(moment);
    trace.contextBuilt(moment, sessions);
    const whole = [overtaken ? OVERTAKEN_NOTE : '', said, finished ? FINISHED_NOTE : '']
      .filter((part) => part !== '')
      .join('\n');
    await trace.brainStarted();
    const names = await address.names();
    let heard = false;
    const turn = await streamTurn(
      this.deps.turns,
      context === '' ? whole : `${context}\n${whole}`,
      (chunk) => {
        trace.chunk(chunk);
        seams.send(chunk);
      },
      address.unsaid(names, now()),
      () => (heard = seams.wanted()),
    );
    await trace.finish();
    return heard ? { text: turn.answered, ended: turn.ended, moment, names } : undefined;
  }

  /** What is put ahead of their words: the recall, then the sessions right now. */
  private async contextFor(
    moment: string,
  ): Promise<{ context: string; sessions: number }> {
    const exchanges = await this.deps.exchanges.read(moment);
    const [cards, focus, waiting, asking] = await Promise.all([
      this.deps.views.list().catch(() => []),
      new VoiceFocusStore(this.deps.home).read().catch(() => null),
      waitingOnYes(this.deps.home, moment, lastAnswered(exchanges)),
      new AgentQuestions(this.deps.home).open(moment).catch(() => []),
    ]);
    const spoke = exchanges.filter((each) => each.unasked !== true).at(-1)?.at;
    const context = [
      momentContext(new Date(moment), spoke),
      recallContext(exchanges, waiting),
      questionsContext(asking),
      askContext(cards, new Date(moment), focus),
    ]
      .filter((part) => part !== '')
      .join('\n');
    return { context, sessions: cards.length };
  }
}
