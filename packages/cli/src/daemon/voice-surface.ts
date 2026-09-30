import {
  ConfirmKeys,
  DAEMON_EVENT,
  DAEMON_METHOD,
  BRIEFING,
  describePause,
  isP256Point,
  SessionPauses,
  SessionHosts,
  UNNAMED_AGENT,
  type DaemonEvent,
  type DaemonRequest,
  type DaemonResponse,
} from '@memnox/core';
import type { Brain } from '../operator/brain';
import { keepOwner, readOwner } from '../operator/owner';
import { backBrief, heldBrief, pausedBrief } from '../operator/voice-prompts';
import { readVocabulary } from '../operator/vocabulary';
import { BrainTurns } from './brain-turns';
import { confirmAnswer } from './confirm';
import { write, type Peer } from './socket-write';
import { WaitingFeed } from './waiting-feed';

/**
 * The daemon's side facing a person rather than an agent: what is waiting on them, their
 * answers, and their questions to their own brain. Kept apart from the hot path that rules
 * on every command, since none of it has that latency budget.
 */

/** A few questions' worth of quiet before the brain's process is let go. */
const BRAIN_IDLE_MS = 5 * 60 * 1_000;

/** Often enough that a held call is spoken while the agent is still waiting on it. */
const FEED_INTERVAL_MS = 500;

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
];

interface VoiceDeps {
  home: string;
  now: () => string;
  log: (message: string) => void;
  feedIntervalMs?: number;
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
  private readonly turns: BrainTurns | null;

  constructor(private readonly deps: VoiceDeps) {
    this.feed = new WaitingFeed(deps.home);
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
    for (const socket of this.subscribers.keys()) socket.destroy();
    this.subscribers.clear();
    this.turns?.close();
  }

  private async answer(request: DaemonRequest): Promise<DaemonResponse> {
    const { home } = this.deps;
    const feed = this.feed;
    if (request.method === DAEMON_METHOD.LOCATE) return this.locate(request);
    if (request.method === DAEMON_METHOD.VOCABULARY) {
      return { id: request.id, ok: true, words: await readVocabulary(this.deps.home) };
    }
    if (request.method === DAEMON_METHOD.WAITING) {
      return { id: request.id, ok: true, waiting: await feed.current(this.deps.now()) };
    }
    if (request.method === DAEMON_METHOD.REGISTER_KEY) return this.registerKey(request);
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
    await turns.ask(said, (chunk) => write(socket, { id: request.id, ok: true, chunk }));
  }

  /** Everything already waiting first, then each new thing as it appears. */
  private async subscribe(socket: Peer, id: number): Promise<void> {
    const feed = this.feed;
    const told = new Set<string>();
    this.subscribers.set(socket, told);
    write(socket, { id, ok: true });
    for (const event of await feed.current(this.deps.now())) {
      told.add(event.subject);
      write(socket, { id, ok: true, event });
    }
    if (this.feedTimer !== null) return;
    this.feedTimer = setInterval(
      () => void this.pushWaiting(),
      this.deps.feedIntervalMs ?? FEED_INTERVAL_MS,
    );
    // A subscriber is not a reason to keep a daemon alive that was asked to stop.
    this.feedTimer.unref();
  }

  private async pushWaiting(): Promise<void> {
    if (this.subscribers.size === 0) return;
    try {
      const waiting = await this.feed.current(this.deps.now());
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
