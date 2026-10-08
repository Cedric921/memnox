import {
  AgentQuestions,
  ASK_INTENT,
  DAEMON_EVENT,
  VoiceFocusStore,
  type DaemonAskChunk,
  type DaemonRequest,
  type TeamCallBrief,
  type SessionView,
} from '@memnox/core';
import type { AddressLimit } from './address-limit';
import {
  askContext,
  foldersContext,
  heardWordsContext,
  lookingAtContext,
  openSessionContext,
  windowContext,
  FINISHED_NOTE,
  heldCallsContext,
  momentContext,
  RULE_NOTE,
  questionsContext,
} from './ask-context';
import { BRAIN_CHUNK } from '../operator/brain';
import { folderUses } from '../operator/folders';
import { readHeardWords } from '../operator/heard-words';
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
import { streamTurn, withoutHolds } from './stream-turn';
import { VoiceTurnTrace } from '../trace/voice-trace';
import { WaitingFeed } from './waiting-feed';
import { keepTeamCalls, teamCallsContext } from './team-calls-store';

/**
 * What the person asks, answered by their own brain one chunk per line, and the guess at it
 * started while they pause. Kept apart from the rest of the voice, since this is the path whose
 * every millisecond is heard.
 */

/** Long enough to cover the rest of a sentence said after a hold, short of a new question. */
const HELD_WITHIN_MS = 60_000;
/** A request this long already says what to do, so a hold on it is a misread and never waits on them. */
const WHOLE_REQUEST_WORDS = 8;

/** The chunks after which the Mac stops reading a turn and listens again. */
export const ENDS_TURN: ReadonlySet<string> = new Set([
  BRAIN_CHUNK.DONE,
  BRAIN_CHUNK.FAILED,
  BRAIN_CHUNK.CANCELLED,
  BRAIN_CHUNK.LIMITED,
]);

/** Said when the brain would only hold on words that were already all of it. */
const SAY_IT_AGAIN = "Sorry, I didn't quite catch that. Could you say it once more?";

interface AskDeps {
  home: string;
  now: () => string;
  turns: BrainTurns;
  views: Pick<SessionViews, 'list' | 'view'>;
  exchanges: RecentExchanges;
  address: AddressLimit;
  log?: (message: string) => void;
}

/** A turn the brain answered, for recall once the person has heard it. */
interface Answered {
  text: string;
  ended: boolean;
  held: boolean;
  moment: string;
  names: Awaited<ReturnType<AddressLimit['names']>>;
}

export class VoiceAsk {
  /** A guess at the answer started while they pause, adopted when the Mac sends the same words. */
  private readonly speculation: Speculation<Answered | undefined>;

  /** When the last answered turn held for the rest, so the next one may not hold again. */
  private heldAt: number | null = null;

  /** The app the person was in at their last words, which the next turn's context names. */
  private lookingAt: string | undefined;
  /** The team's questions the asking device named, which the voice may answer like this machine's own. */
  private teamCalls: TeamCallBrief[] = [];
  private lookingAtWindow: string | undefined;
  /** The session the person has open on the phone, which the next turn is a follow up on. */
  private openSession: string | undefined;

  constructor(private readonly deps: AskDeps) {
    this.speculation = new Speculation(() => deps.turns.cancel());
  }

  /** `mirror` sees every chunk the asker does, so the Mac island can show a phone's turn. */
  async ask(
    socket: Peer,
    request: DaemonRequest,
    said: string,
    mirror?: (chunk: DaemonAskChunk) => void,
  ): Promise<void> {
    this.lookingAt = request.lookingAt;
    this.lookingAtWindow = request.lookingAtWindow;
    this.openSession = request.sessionId;
    if (request.teamCalls !== undefined) {
      this.teamCalls = request.teamCalls;
      await keepTeamCalls(this.deps.home, request.teamCalls, this.deps.now()).catch(
        () => undefined,
      );
    }
    if (request.speculative === true) {
      // Answered at once: nothing of a guess is said on this request, only on the ask that adopts it.
      write(socket, { id: request.id, ok: true, outcome: 'guessing' });
      this.speculation.start(said, (seams) => this.turn(said, false, seams));
      return;
    }
    let ended = false;
    const forward = (chunk: DaemonAskChunk): void => {
      if (ENDS_TURN.has(chunk.kind)) ended = true;
      write(socket, { id: request.id, ok: true, chunk });
      mirror?.(chunk);
    };
    try {
      await this.answer(request, said, forward);
    } finally {
      // The Mac waits on an end before it listens again, so a turn that sent none would leave the orb silent for good.
      if (!ended) forward({ kind: BRAIN_CHUNK.DONE });
    }
  }

  private async answer(
    request: DaemonRequest,
    said: string,
    forward: (chunk: DaemonAskChunk) => void,
  ): Promise<void> {
    // Held keys say they are rules, and letting go says that is all of it, so no guess or hold applies.
    const rule = request.intent === ASK_INTENT.RULE;
    // Never hold twice running: words after a hold are the rest of it, so they are answered.
    const finished = rule || request.finished === true || this.justHeld();
    // Words sent after a hold carry a note a guess never had, so no guess is ever them.
    if (finished) this.speculation.drop();
    const guessed = finished ? null : await this.speculation.adopt(said, forward);
    if (guessed !== null) return this.keep(said, guessed.answer);
    const overtaken = this.speculation.takeOvertaken();
    const seams = { send: forward, wanted: () => true };
    const words = rule ? `${RULE_NOTE}\n${said}` : said;
    await this.keep(said, await this.turn(words, finished, seams, overtaken));
  }

  private justHeld(): boolean {
    return (
      this.heldAt !== null && Date.parse(this.deps.now()) - this.heldAt < HELD_WITHIN_MS
    );
  }

  /** What was said and answered, kept for recall, once the person has heard it. */
  private async keep(said: string, answered: Answered | undefined): Promise<void> {
    if (answered === undefined) return;
    this.heldAt = answered.held ? Date.parse(answered.moment) : null;
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
    const mayHold = !finished && said.split(/\s+/).length < WHOLE_REQUEST_WORDS;
    const ask = (
      words: string,
      send: GuessSeams['send'],
    ): ReturnType<typeof streamTurn> =>
      streamTurn(
        this.deps.turns,
        context === '' ? words : `${context}\n${words}`,
        (chunk) => {
          trace.chunk(chunk);
          send(chunk);
        },
        address.unsaid(names, now()),
        () => (heard = seams.wanted()),
      );
    let turn = await ask(whole, mayHold ? seams.send : withoutHolds(seams.send));
    // A hold after it already said something is that reply, a question usually, so it ends there.
    const spoke = turn.answered.trim() !== '';
    // Asked again here, at once, rather than the Mac listening for more that is not coming.
    if (!mayHold && turn.held && !spoke)
      turn = await ask(`${whole}\n${FINISHED_NOTE}`, withoutHolds(seams.send));
    // Held again on words marked whole, which sent nothing at all: the person hears that it was missed.
    if (!mayHold && turn.held) {
      if (!spoke && turn.answered.trim() === '')
        seams.send({ kind: BRAIN_CHUNK.TEXT, text: SAY_IT_AGAIN });
      seams.send({ kind: BRAIN_CHUNK.DONE });
    }
    await trace.finish();
    return heard
      ? { text: turn.answered, ended: turn.ended, held: turn.held, moment, names }
      : undefined;
  }

  /** What is put ahead of their words: the recall, then the sessions right now. */
  private async contextFor(
    moment: string,
  ): Promise<{ context: string; sessions: number }> {
    const exchanges = await this.deps.exchanges.read(moment);
    const [cards, focus, waiting, asking, open] = await Promise.all([
      this.deps.views.list().catch(() => []),
      new VoiceFocusStore(this.deps.home).read().catch(() => null),
      waitingOnYes(this.deps.home, moment, lastAnswered(exchanges)),
      new AgentQuestions(this.deps.home).open(moment).catch(() => []),
      this.openView(),
    ]);
    const [heardWords, folders, held] = await Promise.all([
      readHeardWords(this.deps.home).catch(() => []),
      folderUses(this.deps.home, Date.parse(moment)).catch(() => []),
      new WaitingFeed(this.deps.home)
        .current(moment)
        .then((events) => events.filter((each) => each.kind === DAEMON_EVENT.HELD))
        .catch(() => []),
    ]);
    const spoke = exchanges.filter((each) => each.unasked !== true).at(-1)?.at;
    const context = [
      momentContext(new Date(moment), spoke),
      lookingAtContext(this.lookingAt),
      windowContext(this.lookingAtWindow),
      heardWordsContext(heardWords),
      foldersContext(folders),
      recallContext(exchanges, waiting),
      questionsContext(asking),
      heldCallsContext(held),
      teamCallsContext(this.teamCalls),
      openSessionContext(open),
      // Last, since it ends in the heading their words follow.
      askContext(cards, new Date(moment), focus),
    ]
      .filter((part) => part !== '')
      .join('\n');
    return { context, sessions: cards.length };
  }

  /** A phone may only name a session, so one nothing is known about is left out rather than refused. */
  private async openView(): Promise<SessionView | null> {
    const sessionId = this.openSession;
    if (sessionId === undefined) return null;
    const view = await this.deps.views.view(sessionId).catch(() => null);
    if (view === null)
      this.deps.log?.(
        `ask named ${JSON.stringify(sessionId)}, which no session view knows`,
      );
    return view;
  }
}
