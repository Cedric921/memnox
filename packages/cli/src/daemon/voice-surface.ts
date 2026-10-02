import {
  ConfirmKeys,
  DAEMON_EVENT,
  DAEMON_METHOD,
  BRIEFING,
  DELIVERY,
  describePause,
  DisplayRequests,
  SPAN_KIND,
  SPAN_STATUS,
  isP256Point,
  SessionPauses,
  SessionHosts,
  UNNAMED_AGENT,
  VoiceFocusStore,
  type DaemonAskChunk,
  type DaemonEvent,
  type DaemonRequest,
  type DaemonResponse,
  type Delivery,
} from '@memnox/core';
import { BRAIN_CHUNK, type Brain } from '../operator/brain';
import { keepOwner, readOwner } from '../operator/owner';
import {
  backBrief,
  heldBrief,
  noticeBrief,
  pausedBrief,
} from '../operator/voice-prompts';
import { readVocabulary } from '../operator/vocabulary';
import { BrainTurns } from './brain-turns';
import { confirmAnswer } from './confirm';
import { NoticeWatcher } from './notice-watch';
import { askContext, FINISHED_NOTE } from './ask-context';
import { SessionViews } from './session-view';
import { write, type Peer } from './socket-write';
import { recordSpan, VoiceTurnTrace } from '../trace/voice-trace';
import { WaitingFeed } from './waiting-feed';

/**
 * The daemon's side facing a person rather than an agent: what is waiting on them, their
 * answers, and their questions to their own brain. Kept apart from the hot path that rules
 * on every command, since none of it has that latency budget.
 */

/** Half an hour of quiet before the brain's process is let go, since starting it again costs the next answer ten seconds. */
const BRAIN_IDLE_MS = 30 * 60 * 1_000;

/** Often enough that a held call is spoken while the agent is still waiting on it. */
const FEED_INTERVAL_MS = 500;

/** A finished session is news for minutes, so the ledger is read for it far less often. */
const NOTICE_INTERVAL_MS = 10_000;

/** A turn's worth of the Mac's steps; more than this is not a turn. */
const MOST_MAC_SPANS = 12;

const VOICE_METHODS: readonly string[] = [
  DAEMON_METHOD.SUBSCRIBE,
  DAEMON_METHOD.WAITING,
  DAEMON_METHOD.CONFIRM,
  DAEMON_METHOD.REGISTER_KEY,
  DAEMON_METHOD.ASK,
  DAEMON_METHOD.CANCEL,
  DAEMON_METHOD.LOCATE,
  DAEMON_METHOD.BRIEF,
  DAEMON_METHOD.WARM,
  DAEMON_METHOD.VOCABULARY,
  DAEMON_METHOD.SESSION_VIEW,
  DAEMON_METHOD.SESSIONS_LIST,
  DAEMON_METHOD.DELIVERED,
  DAEMON_METHOD.TRACE,
];

interface VoiceDeps {
  home: string;
  now: () => string;
  log: (message: string) => void;
  feedIntervalMs?: number;
  noticeIntervalMs?: number;
  brain?: () => Brain;
  brainIdleMs?: number;
}

export function isVoiceMethod(method: string): boolean {
  return VOICE_METHODS.includes(method);
}

export class VoiceSurface {
  /** Each subscriber with what it has already been told, so nobody hears a thing twice or never. */
  private readonly subscribers = new Map<Peer, Set<string>>();
  private readonly feed: WaitingFeed;
  private feedTimer: ReturnType<typeof setInterval> | null = null;
  private noticeTimer: ReturnType<typeof setInterval> | null = null;
  private readonly notices: NoticeWatcher;
  private readonly turns: BrainTurns | null;
  private readonly views: SessionViews;

  constructor(private readonly deps: VoiceDeps) {
    this.feed = new WaitingFeed(deps.home);
    this.notices = new NoticeWatcher(deps.home, deps.now());
    this.views = new SessionViews(deps.home);
    this.turns =
      deps.brain === undefined
        ? null
        : new BrainTurns(deps.brain, deps.brainIdleMs ?? BRAIN_IDLE_MS);
  }

  async respond(socket: Peer, request: DaemonRequest): Promise<void> {
    // Kept for the next time the brain starts, so it speaks to them by the name they chose.
    if (request.owner !== undefined)
      await keepOwner(this.deps.home, request.owner).catch(() => undefined);
    if (request.method === DAEMON_METHOD.BRIEF) return this.brief(socket, request);
    if (request.method === DAEMON_METHOD.WARM) {
      // Answered at once and warmed behind it, since the person is still talking.
      write(socket, { id: request.id, ok: true, outcome: 'warming' });
      void this.turns?.warm();
      return;
    }
    if (request.method === DAEMON_METHOD.SUBSCRIBE)
      return this.subscribe(socket, request.id);
    if (request.method === DAEMON_METHOD.ASK) return this.ask(socket, request);
    if (request.method === DAEMON_METHOD.CANCEL) {
      const stopped = this.turns?.cancel() ?? false;
      write(socket, {
        id: request.id,
        ok: true,
        outcome: stopped ? 'cancelled' : 'nothing to cancel',
      });
      return;
    }
    const response = await this.answer(request).catch((err: unknown): DaemonResponse => ({
      id: request.id,
      ok: false,
      error: String(err),
    }));
    write(socket, response);
  }

  broadcast(event: DaemonEvent): void {
    for (const socket of this.subscribers.keys())
      write(socket, { id: 0, ok: true, event });
  }

  drop(socket: Peer): void {
    this.subscribers.delete(socket);
  }

  close(): void {
    if (this.feedTimer !== null) clearInterval(this.feedTimer);
    this.feedTimer = null;
    if (this.noticeTimer !== null) clearInterval(this.noticeTimer);
    this.noticeTimer = null;
    for (const socket of this.subscribers.keys()) socket.destroy();
    this.subscribers.clear();
    this.turns?.close();
  }

  private async answer(request: DaemonRequest): Promise<DaemonResponse> {
    const { home } = this.deps;
    const feed = this.feed;
    if (request.method === DAEMON_METHOD.LOCATE) return this.locate(request);
    if (request.method === DAEMON_METHOD.SESSION_VIEW) return this.sessionView(request);
    if (request.method === DAEMON_METHOD.SESSIONS_LIST) {
      return { id: request.id, ok: true, sessions: await this.views.list() };
    }
    if (request.method === DAEMON_METHOD.VOCABULARY) {
      return { id: request.id, ok: true, words: await readVocabulary(this.deps.home) };
    }
    if (request.method === DAEMON_METHOD.WAITING) {
      return { id: request.id, ok: true, waiting: await feed.current(this.deps.now()) };
    }
    if (request.method === DAEMON_METHOD.REGISTER_KEY) return this.registerKey(request);
    if (request.method === DAEMON_METHOD.DELIVERED) return this.delivered(request);
    if (request.method === DAEMON_METHOD.TRACE) return this.macSpans(request);
    if (request.subject === undefined || request.answer === undefined) {
      return {
        id: request.id,
        ok: false,
        error: 'confirm needs a subject and an answer',
      };
    }
    const result = await confirmAnswer(home, {
      subject: request.subject,
      answer: request.answer,
      at: this.deps.now(),
      ...(request.signature === undefined ? {} : { signature: request.signature }),
    });
    return result.ok
      ? { id: request.id, ok: true, outcome: result.outcome }
      : { id: request.id, ok: false, error: result.error };
  }

  /** Whether a typed instruction landed, kept for the brain that is waiting to say so. */
  private async delivered(request: DaemonRequest): Promise<DaemonResponse> {
    const outcome = request.answer;
    if (request.subject === undefined || !isDelivery(outcome)) {
      return {
        id: request.id,
        ok: false,
        error: 'delivered needs a subject and an outcome',
      };
    }
    const kept = await new DisplayRequests(this.deps.home).deliver(request.subject, {
      outcome,
      at: this.deps.now(),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    });
    return { id: request.id, ok: true, outcome: kept ? 'kept' : 'nobody waiting' };
  }

  /** A session as it is right now, for the live window on it. */
  private async sessionView(request: DaemonRequest): Promise<DaemonResponse> {
    if (request.sessionId === undefined) {
      return { id: request.id, ok: false, error: 'session-view needs a session' };
    }
    const session = await this.views.view(request.sessionId);
    return session === null
      ? {
          id: request.id,
          ok: false,
          error: `nothing is known about ${request.sessionId}`,
        }
      : { id: request.id, ok: true, session };
  }

  /** The Mac app's key, trusted on first use and never replaced from here. */
  private async registerKey(request: DaemonRequest): Promise<DaemonResponse> {
    if (request.point === undefined || !isP256Point(request.point)) {
      return { id: request.id, ok: false, error: 'register-key needs a P-256 point' };
    }
    const outcome = await new ConfirmKeys(this.deps.home).register(
      request.point,
      this.deps.now(),
    );
    if ('registered' in outcome)
      return { id: request.id, ok: true, outcome: 'registered' };
    // Said, never replaced: the app compares and tells the person when it is not theirs.
    const same = outcome.alreadyRegistered.point === request.point;
    return { id: request.id, ok: same, outcome: same ? 'registered' : 'another key' };
  }

  /** Where the session's agent runs, and whether it still does. */
  private async locate(request: DaemonRequest): Promise<DaemonResponse> {
    const sessionId = request.sessionId;
    if (sessionId === undefined) {
      return { id: request.id, ok: false, error: 'locate needs a session' };
    }
    const host = await new SessionHosts(this.deps.home).read(sessionId);
    if (host === null) {
      return {
        id: request.id,
        ok: false,
        error: `nothing is known about where ${sessionId} runs`,
      };
    }
    const { pid, seenAt, ...where } = host;
    return { id: request.id, ok: true, location: { ...where, alive: isRunning(pid) } };
  }

  /** Something that happened, told by the brain in its own words, streamed like an answer. */
  private async brief(socket: Peer, request: DaemonRequest): Promise<void> {
    const turns = this.turns;
    const prompt = await this.briefFor(request);
    if (turns === null || prompt === null) {
      const error = turns === null ? 'no brain is configured' : 'nothing to brief about';
      write(socket, { id: request.id, ok: false, error });
      return;
    }
    await turns.ask(prompt, (chunk) =>
      write(socket, { id: request.id, ok: true, chunk }),
    );
  }

  private async briefFor(request: DaemonRequest): Promise<string | null> {
    if (request.briefing === BRIEFING.BACK) {
      return request.since === undefined ? null : backBrief(request.since);
    }
    const waiting = await this.feed.current(this.deps.now());
    const event = waiting.find((each) => each.subject === request.subject);
    if (request.briefing === BRIEFING.NOTICE && request.subject !== undefined) {
      const notice = this.notices.recent(request.subject);
      return notice === null
        ? null
        : noticeBrief(notice, await readOwner(this.deps.home));
    }
    if (request.briefing === BRIEFING.HELD) {
      return event === undefined
        ? null
        : heldBrief(event, await readOwner(this.deps.home));
    }
    if (request.briefing === BRIEFING.PAUSED && request.subject !== undefined) {
      const pause = await new SessionPauses(this.deps.home).read(request.subject);
      return pause === null
        ? null
        : pausedBrief({
            kind: DAEMON_EVENT.PAUSED,
            subject: pause.sessionId,
            agent: UNNAMED_AGENT,
            summary: describePause(pause),
            at: pause.pausedAt,
          });
    }
    return null;
  }

  /** What the person said, answered by their own brain one chunk per line. */
  private async ask(socket: Peer, request: DaemonRequest): Promise<void> {
    const said = request.said?.trim() ?? '';
    const turns = this.turns;
    if (said === '' || turns === null) {
      const error = said === '' ? 'ask needs what was said' : 'no brain is configured';
      write(socket, { id: request.id, ok: false, error });
      return;
    }
    const trace = new VoiceTurnTrace(
      this.deps.home,
      this.deps.now,
      said.split(/\s+/).length,
    );
    const building = this.deps.now();
    // Best effort: without it the brain looks the sessions up itself, only slower.
    const [cards, focus] = await Promise.all([
      this.views.list().catch(() => []),
      new VoiceFocusStore(this.deps.home).read().catch(() => null),
    ]);
    trace.contextBuilt(building, cards.length);
    const context = askContext(cards, new Date(this.deps.now()), focus);
    const whole = request.finished === true ? `${said}\n${FINISHED_NOTE}` : said;
    const asked = context === '' ? whole : `${context}\n${whole}`;
    await trace.brainStarted();
    let held = false;
    await turns.ask(asked, (chunk) => {
      trace.chunk(chunk);
      // Whatever the brain writes after holding would be dropped anyway, so the orb listens now.
      if (held) return;
      write(socket, { id: request.id, ok: true, chunk });
      if (!isHold(chunk)) return;
      held = true;
      write(socket, { id: request.id, ok: true, chunk: { kind: BRAIN_CHUNK.DONE } });
      turns.cancel();
    });
    await trace.finish();
  }

  /** The Mac's own timings, hung on the question they belong to so one trace shows the whole answer. */
  private async macSpans(request: DaemonRequest): Promise<DaemonResponse> {
    for (const span of (request.spans ?? []).slice(0, MOST_MAC_SPANS)) {
      await recordSpan(this.deps.home, {
        name: `mac.${span.name}`,
        kind: SPAN_KIND.MAC,
        startAt: span.startAt,
        endAt: span.endAt,
        status: SPAN_STATUS.OK,
        attributes: span.attributes ?? {},
        under: 'root',
      });
    }
    return { id: request.id, ok: true, outcome: 'kept' };
  }

  /** Everything already waiting first, then each new thing as it appears. */
  private async subscribe(socket: Peer, id: number): Promise<void> {
    const feed = this.feed;
    const told = new Set<string>();
    this.subscribers.set(socket, told);
    write(socket, { id, ok: true });
    // The Mac app is listening, so the first question should meet a brain that is already up.
    void this.turns?.warm();
    for (const event of await feed.everything(this.deps.now())) {
      told.add(event.subject);
      write(socket, { id, ok: true, event });
    }
    this.watchNotices();
    if (this.feedTimer !== null) return;
    this.feedTimer = setInterval(
      () => void this.pushWaiting(),
      this.deps.feedIntervalMs ?? FEED_INTERVAL_MS,
    );
    // A subscriber is not a reason to keep a daemon alive that was asked to stop.
    this.feedTimer.unref();
  }

  /** Reads the ledger for news every few seconds while somebody is listening. */
  private watchNotices(): void {
    if (this.noticeTimer !== null) return;
    this.noticeTimer = setInterval(() => {
      if (this.subscribers.size === 0) return;
      this.notices
        .look(this.deps.now())
        .then((events) => events.forEach((event) => this.broadcast(event)))
        .catch((err: unknown) =>
          this.deps.log(`could not look for news: ${String(err)}`),
        );
    }, this.deps.noticeIntervalMs ?? NOTICE_INTERVAL_MS);
    this.noticeTimer.unref();
  }

  private async pushWaiting(): Promise<void> {
    if (this.subscribers.size === 0) return;
    try {
      const waiting = await this.feed.everything(this.deps.now());
      const still = new Set(waiting.map((event) => event.subject));
      for (const [socket, told] of this.subscribers) {
        for (const event of waiting) {
          if (told.has(event.subject)) continue;
          told.add(event.subject);
          write(socket, { id: 0, ok: true, event });
        }
        // Said, so a question answered in a terminal or a DM stops being asked out loud.
        for (const subject of [...told]) {
          if (still.has(subject)) continue;
          told.delete(subject);
          write(socket, { id: 0, ok: true, event: settled(subject, this.deps.now()) });
        }
      }
    } catch (err) {
      this.deps.log(`could not read what is waiting: ${String(err)}`);
    }
  }
}

function settled(subject: string, at: string): DaemonEvent {
  return {
    kind: DAEMON_EVENT.SETTLED,
    subject,
    agent: UNNAMED_AGENT,
    summary: 'no longer waiting on you',
    at,
  };
}

/** Signal zero asks whether the process exists without touching it. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Not ours to signal still means it is there.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const DELIVERIES: readonly string[] = Object.values(DELIVERY);

function isDelivery(value: string | undefined): value is Delivery {
  return value !== undefined && DELIVERIES.includes(value);
}

/** The brain saying the person is mid thought, by the tool's own name whatever server prefix it carries. */
function isHold(chunk: DaemonAskChunk): boolean {
  return chunk.kind === BRAIN_CHUNK.TOOL && (chunk.tool ?? '').endsWith('keep_listening');
}
