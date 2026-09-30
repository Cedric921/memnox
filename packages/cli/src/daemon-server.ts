import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ACTOR_TYPE,
  CircuitBreaker,
  DAEMON_METHOD,
  DECISION_EFFECT,
  describePause,
  encode,
  decodeRequest,
  LineBuffer,
  SessionLimits,
  SessionPauses,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  exhaustedBy,
  socketPathFor,
  TOOL_CLASS,
  ViolationMemory,
  ConfirmKeys,
  DAEMON_EVENT,
  isP256Point,
  type DaemonEvent,
  type BreakerBreach,
  type Budget,
  type FleetSpend,
  type MemnoxEvent,
  type DaemonRequest,
  type DaemonResponse,
  type LocalGate,
  type SessionPause,
  UNNAMED_AGENT,
  UNNAMED_SESSION,
} from '@memnox/core';
import { confirmAnswer } from './daemon/confirm';
import { WaitingFeed } from './daemon/waiting-feed';

/**
 * The daemon: one process holding the rules, so a seam pays a connect rather than a file
 * read per command. Optional, because every seam falls back to evaluating in process.
 */

interface DaemonDeps {
  gate?: LocalGate;
  limits?: SessionLimits;
  violations?: ViolationMemory;
  breaker?: CircuitBreaker;
  /** Where a pause is written, so every seam in the session sees it. */
  pauses?: SessionPauses;
  budgets?: readonly Budget[];
  /** What the rest of the fleet has spent, as of the last heartbeat. */
  fleetSpend?: readonly FleetSpend[];
  /** Spent today, read from the ledger at startup, or killing the daemon clears a budget. */
  spentAlready?: readonly MemnoxEvent[];
  now?: () => string;
  /** How often subscribers are checked for something new to hear about. */
  feedIntervalMs?: number;
  log: (message: string) => void;
}

/** Often enough that a held call is spoken while the agent is still waiting on it. */
const FEED_INTERVAL_MS = 500;

/** Methods that read or write files, so they are answered after an await rather than inline. */
const ASYNC_METHODS: readonly string[] = [
  DAEMON_METHOD.WAITING,
  DAEMON_METHOD.CONFIRM,
  DAEMON_METHOD.REGISTER_KEY,
];

/** The shorter of the two platform limits, so one number is right on both. */
const SOCKET_PATH_LIMIT = 103;
const SOCKET_DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;

export class MemnoxDaemon {
  private readonly limits: SessionLimits;
  private readonly violations: ViolationMemory;
  private readonly breaker: CircuitBreaker;
  private readonly pauses: SessionPauses | null;
  /** Read once per answer rather than per session, so the hot path stays a map lookup. */
  private readonly held = new Map<string, SessionPause>();
  /** Charged as they happen, on top of what the ledger already held at startup. */
  private readonly charged: MemnoxEvent[] = [];
  private server: Server | null = null;
  private home: string | null = null;
  /** Each subscriber with what it has already been told, so nobody hears a thing twice or never. */
  private readonly subscribers = new Map<Socket, Set<string>>();
  private feed: WaitingFeed | null = null;
  private feedTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: DaemonDeps) {
    this.limits = deps.limits ?? new SessionLimits();
    this.violations = deps.violations ?? new ViolationMemory();
    this.breaker = deps.breaker ?? new CircuitBreaker();
    this.pauses = deps.pauses ?? null;
  }

  async listen(home: string): Promise<string> {
    const path = socketPathFor(home);
    // Over the kernel's cap `listen` fails with EADDRINUSE, which sends somebody hunting
    // for a process that does not exist, so the real cause is named here.
    if (Buffer.byteLength(path) > SOCKET_PATH_LIMIT) {
      throw new Error(
        `The daemon's socket path is ${Buffer.byteLength(path)} bytes and the kernel allows ${SOCKET_PATH_LIMIT}:\n  ${path}\n` +
          'Use a shorter home directory. The interceptors still evaluate in process, which is the same rules.',
      );
    }
    await mkdir(dirname(path), { recursive: true, mode: SOCKET_DIR_MODE });
    // A stale socket from a killed daemon would refuse every connection.
    await rm(path, { force: true });

    const server = createServer((socket) => this.serve(socket));
    this.server = server;
    this.home = home;
    this.feed = new WaitingFeed(home);

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => resolve());
    });
    // Owner only, because anything that can talk to this socket can ask about your rules.
    await chmod(path, SOCKET_MODE);
    return path;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    if (this.feedTimer !== null) clearInterval(this.feedTimer);
    this.feedTimer = null;
    for (const socket of this.subscribers.keys()) socket.destroy();
    this.subscribers.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
  }

  /** Lifts a hold, so `memnox resume` reaches the daemon that is enforcing it. */
  resume(sessionId: string): boolean {
    return this.held.delete(sessionId);
  }

  private serve(socket: Socket): void {
    const reader = new LineBuffer();
    socket.setEncoding('utf8');
    // Chained, so a connection that sends two lines gets two answers in the order it asked.
    let answered: Promise<void> = Promise.resolve();
    socket.on('data', (chunk: string) => {
      for (const line of reader.push(chunk)) {
        answered = answered.then(() => this.respond(line, socket));
      }
    });
    socket.on('close', () => this.subscribers.delete(socket));
    socket.on('error', (err) => {
      // A client that hung up mid-write is ordinary; it must never take the daemon down.
      this.deps.log(`client dropped: ${String(err)}`);
    });
  }

  private async respond(line: string, socket: Socket): Promise<void> {
    const request = decodeRequest(line);
    if (request === null) {
      write(socket, { id: 0, ok: false, error: 'not a request this daemon understands' });
      return;
    }
    if (request.method === DAEMON_METHOD.SUBSCRIBE) {
      await this.subscribe(socket, request.id);
      return;
    }
    const response = ASYNC_METHODS.includes(request.method)
      ? await this.answerAsync(request).catch((err: unknown): DaemonResponse => ({
          id: request.id,
          ok: false,
          error: String(err),
        }))
      : this.answer(request);
    write(socket, response);
  }

  private answer(request: DaemonRequest): DaemonResponse {
    if (request.method === DAEMON_METHOD.PING) return { id: request.id, ok: true };
    if (request.method === DAEMON_METHOD.RECORD) return this.record(request);
    if (request.method === DAEMON_METHOD.STATUS) {
      return this.heldResponse(request) ?? { id: request.id, ok: true };
    }
    if (request.method === DAEMON_METHOD.EVALUATE) return this.evaluate(request);
    return { id: request.id, ok: true };
  }

  private async answerAsync(request: DaemonRequest): Promise<DaemonResponse> {
    const home = this.home;
    const feed = this.feed;
    if (home === null || feed === null) {
      return { id: request.id, ok: false, error: 'the daemon is not listening yet' };
    }
    if (request.method === DAEMON_METHOD.WAITING) {
      return { id: request.id, ok: true, waiting: await feed.current(this.now()) };
    }
    if (request.method === DAEMON_METHOD.REGISTER_KEY) {
      if (request.point === undefined || !isP256Point(request.point)) {
        return { id: request.id, ok: false, error: 'register-key needs a P-256 point' };
      }
      const outcome = await new ConfirmKeys(home).register(request.point, this.now());
      if ('registered' in outcome)
        return { id: request.id, ok: true, outcome: 'registered' };
      // Said, never replaced: the app compares and tells the person when it is not theirs.
      const same = outcome.alreadyRegistered.point === request.point;
      return { id: request.id, ok: same, outcome: same ? 'registered' : 'another key' };
    }
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
      at: this.now(),
      ...(request.signature === undefined ? {} : { signature: request.signature }),
    });
    return result.ok
      ? { id: request.id, ok: true, outcome: result.outcome }
      : { id: request.id, ok: false, error: result.error };
  }

  /** Everything already waiting first, then each new thing as it appears. */
  private async subscribe(socket: Socket, id: number): Promise<void> {
    const feed = this.feed;
    if (feed === null) {
      write(socket, { id, ok: false, error: 'the daemon is not listening yet' });
      return;
    }
    const told = new Set<string>();
    this.subscribers.set(socket, told);
    write(socket, { id, ok: true });
    for (const event of await feed.current(this.now())) {
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
    if (this.subscribers.size === 0 || this.feed === null) return;
    try {
      const waiting = await this.feed.current(this.now());
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
          write(socket, { id: 0, ok: true, event: settled(subject, this.now()) });
        }
      }
    } catch (err) {
      this.deps.log(`could not read what is waiting: ${String(err)}`);
    }
  }

  private broadcast(event: DaemonEvent): void {
    for (const socket of this.subscribers.keys())
      write(socket, { id: 0, ok: true, event });
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  /**
   * What happened, after it happened. The breaker watches outcomes, so this is the only
   * place its signals can be counted.
   */
  private record(request: DaemonRequest): DaemonResponse {
    const sessionId = request.sessionId ?? UNNAMED_SESSION;
    const action = request.action ?? 'unknown';
    const now = this.now();
    if (request.driftOnly === true) {
      const drift = this.breaker.observeDrift(sessionId);
      if (drift !== null)
        this.hold({ sessionId, breach: drift, lastAction: action, now });
      return { id: request.id, ok: true };
    }

    const breach = this.breaker.observe({
      sessionId,
      fingerprint: `${action}:${request.target ?? ''}`,
      action,
      at: now,
      failed: request.exitCode !== undefined && request.exitCode !== 0,
      ...(request.exitCode === undefined
        ? {}
        : { failureKind: String(request.exitCode) }),
      ...(request.outOfScope === undefined ? {} : { outOfScope: request.outOfScope }),
      ...(request.costUsd === undefined ? {} : { costUsd: request.costUsd }),
    });
    if (breach !== null) this.hold({ sessionId, breach, lastAction: action, now });

    // Only what ran is charged, or a strict policy would exhaust the budget it protects.
    if (request.exitCode === undefined || request.exitCode === 0) {
      this.charge(sessionId, action, now);
    }
    return { id: request.id, ok: true };
  }

  /** A row shaped like the ledger's, so one domain counts both halves the same way. */
  private charge(sessionId: string, action: string, now: string): void {
    this.charged.push({
      id: `evt_daemon_${this.charged.length}`,
      schemaVersion: EVENT_SCHEMA_VERSION,
      at: now,
      sessionId,
      agent: UNNAMED_AGENT,
      actorType: ACTOR_TYPE.AGENT,
      surface: EVENT_SURFACE.SHELL,
      operation: action,
      class: TOOL_CLASS.UNKNOWN,
      effect: DECISION_EFFECT.ALLOW,
      mode: ENFORCEMENT_MODE.ENFORCE,
      reason: 'charged against a budget',
    });
  }

  /** Held in memory and on disk: the seams are other processes and have to see it. */
  private hold(input: HoldInput): void {
    const { sessionId, breach, lastAction, now } = input;
    if (this.held.has(sessionId)) return;
    const pause: SessionPause = {
      sessionId,
      signal: breach.signal,
      reason: breach.reason,
      reached: breach.reached,
      ceiling: breach.ceiling,
      pausedAt: now,
      lastAction,
    };
    this.held.set(sessionId, pause);
    this.deps.log(`paused ${sessionId}: ${breach.reason}`);
    this.broadcast({
      kind: DAEMON_EVENT.PAUSED,
      subject: sessionId,
      agent: UNNAMED_AGENT,
      summary: describePause(pause),
      at: now,
    });
    void this.pauses?.pause(pause).catch((err: unknown) => {
      // A pause that could not be written still holds here; say so rather than lose it.
      this.deps.log(`could not write the pause: ${String(err)}`);
    });
  }

  /** Non-null when this session is held. Shaped as a refusal an agent can read. */
  private heldResponse(request: DaemonRequest): DaemonResponse | null {
    const pause = this.held.get(request.sessionId ?? UNNAMED_SESSION);
    if (pause === undefined) return null;
    return {
      id: request.id,
      ok: true,
      effect: DECISION_EFFECT.DENY,
      reason: describePause(pause),
      paused: { signal: pause.signal, reason: pause.reason },
    };
  }

  /** Pause, then budget, then limits, then rules: each stops the call before the next is asked. */
  private evaluate(request: DaemonRequest): DaemonResponse {
    const action = request.action;
    if (action === undefined) {
      return { id: request.id, ok: false, error: 'evaluate needs an action' };
    }
    const call: EvaluatedCall = {
      request,
      action,
      now: this.now(),
      sessionId: request.sessionId ?? UNNAMED_SESSION,
    };
    return (
      this.heldResponse(request) ??
      this.budgetRefusal(call) ??
      this.limitRefusal(call) ??
      this.ruleVerdict(call)
    );
  }

  /** "No allowance left" and "not allowed" lead to different fixes, so a spent budget says so. */
  private budgetRefusal(call: EvaluatedCall): DaemonResponse | null {
    const budgets = this.deps.budgets ?? [];
    if (budgets.length === 0) return null;
    const spent = exhaustedBy(budgets, {
      action: call.action,
      events: [...(this.deps.spentAlready ?? []), ...this.charged],
      now: call.now,
      sessionId: call.sessionId,
      fleet: this.deps.fleetSpend ?? [],
    });
    if (spent === null) return null;
    return {
      id: call.request.id,
      ok: true,
      effect: DECISION_EFFECT.DENY,
      reason: spent.reason,
      limit: `budget:${spent.budget.name}`,
    };
  }

  /** A session already past its ceiling is stopped whatever the rules say about this call. */
  private limitRefusal(call: EvaluatedCall): DaemonResponse | null {
    const fingerprint = `${call.action}:${call.request.target ?? ''}`;
    const breach = this.limits.record(call.sessionId, fingerprint, call.now);
    if (breach === null) return null;
    return {
      id: call.request.id,
      ok: true,
      effect: DECISION_EFFECT.DENY,
      reason: breach.reason,
      limit: breach.kind,
    };
  }

  private ruleVerdict(call: EvaluatedCall): DaemonResponse {
    const { request, action } = call;
    const gate = this.deps.gate;
    if (gate === undefined) {
      return {
        id: request.id,
        ok: true,
        effect: DECISION_EFFECT.ALLOW,
        reason: 'no rules configured',
      };
    }
    const target = request.target === undefined ? {} : { target: request.target };
    const verdict = gate.evaluate({ action, ...target });
    if (verdict.effect === DECISION_EFFECT.ALLOW) {
      return { id: request.id, ok: true, effect: verdict.effect, reason: verdict.reason };
    }

    const seen = this.violations.record({ action, at: call.now, ...target });
    const repeated = this.violations.isRepeated(action, request.target)
      ? ` (asked ${seen} times now, so the rule may not match how this work is done)`
      : '';
    return {
      id: request.id,
      ok: true,
      effect: verdict.effect,
      reason: `${verdict.reason}${repeated}`,
      ...(verdict.alternative === undefined ? {} : { alternative: verdict.alternative }),
    };
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

/** A client that hung up before its answer is ordinary, so nothing is written to it. */
function write(socket: Socket, response: DaemonResponse): void {
  if (!socket.destroyed) socket.write(encode(response));
}

interface HoldInput {
  sessionId: string;
  breach: BreakerBreach;
  lastAction: string;
  now: string;
}

/** One evaluate request, with the defaults every step would otherwise resolve again. */
interface EvaluatedCall {
  request: DaemonRequest;
  action: string;
  now: string;
  sessionId: string;
}
