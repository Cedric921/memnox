import {
  AGENT_ID_PREFIX,
  DAEMON_EVENT,
  DELIVERY,
  Devices,
  DISPLAY,
  DisplayRequests,
  holds,
  MAC_DISPLAYS,
  MAC_READS,
  PROPOSAL_KIND,
  Proposals,
  REMOTE_CAPABILITY,
  type DaemonEvent,
  type DaemonResponse,
  type DeviceRecord,
  type DisplayKind,
} from '@memnox/core';
import { displayName, readNames } from '../agents/names';
import { doneText, macRationale, NOT_ALLOWED_ON_MAC, OPEN_THE_MAC } from './done-lines';
import { write, type Peer } from './socket-write';
import { settled } from './waiting-feed';

/**
 * Where an answer goes when a phone asked: words to the phone, hands on the Mac. A show only the
 * Mac can do goes to the Mac app, as a proposal the phone signs unless it only reads or the phone drives.
 */

/** A show raised this long after a phone's question ended still belongs to it, since the feed is polled. */
const ORIGIN_WINDOW_MS = 60_000;

/** As long as a person takes to look at a phone and sign. */
const MAC_PROPOSAL_TTL_MS = 2 * 60_000;

/** The last few questions are enough to tell whose a show is. */
const ASKS_KEPT = 8;

const PROPOSED_BY = 'memnox';

/** Shows that name a session the phone can fly to and open itself, so the phone that asked hears them too. */
const PHONE_SHOWS: readonly DisplayKind[] = [
  DISPLAY.FOCUS,
  DISPLAY.OPEN,
  DISPLAY.CARD,
  DISPLAY.WALK,
];

interface Ask {
  deviceId?: string;
  at: string;
  endedAt?: string;
}

export interface RouterDeps {
  home: string;
  now: () => string;
  driving: (deviceId: string) => boolean;
  /** One line to a device's live session, false when it has none. */
  tell: (deviceId: string, response: DaemonResponse) => boolean;
  /** What every event carries on its way out, such as which phone holds the voice. */
  stamp?: (event: DaemonEvent) => DaemonEvent;
}

/** A show marked for the Mac app when only the Mac app can do it. */
export function markNeedsMac(event: DaemonEvent): DaemonEvent {
  const forMac =
    event.kind === DAEMON_EVENT.SHOW &&
    event.display !== undefined &&
    MAC_DISPLAYS.includes(event.display);
  return forMac ? { ...event, needsMac: true } : event;
}

/** A phone hears what waits on its person, never the Mac's own shows, who drives it, a phone's words or where the voice is. */
export function heardRemotely(event: DaemonEvent): boolean {
  return (
    event.kind !== DAEMON_EVENT.SHOW &&
    event.drivenBy === undefined &&
    event.phoneTurn === undefined &&
    event.voiceOn === undefined
  );
}

/** A show naming a session, which the phone that asked for it may open on its own screen. */
function shownOnPhone(event: DaemonEvent): boolean {
  return (
    event.kind === DAEMON_EVENT.SHOW &&
    event.sessionId !== undefined &&
    event.display !== undefined &&
    PHONE_SHOWS.includes(event.display)
  );
}

/** One waiting event as a subscriber gets it, or null when it is not theirs; phone is its device, absent for the Mac. */
function waitingFor(
  event: DaemonEvent,
  to: { phone?: string; origin?: string; claimed: ReadonlySet<string> },
): DaemonEvent | null {
  const done =
    to.origin === undefined ? event : { ...event, origin: { deviceId: to.origin } };
  // The phone that asked flies to the session its show names, whatever the Mac does with it.
  if (to.phone !== undefined && to.origin === to.phone && shownOnPhone(event))
    return done;
  if (to.claimed.has(event.subject)) return null;
  return to.phone !== undefined && !heardRemotely(event) ? null : done;
}

interface WaitingRoutes {
  claimed: ReadonlySet<string>;
  now: string;
  /** The device a subscriber is, absent for the Mac app. */
  phoneOf: (socket: Peer) => string | undefined;
  originOf: (event: DaemonEvent) => string | undefined;
  stamp: (event: DaemonEvent) => DaemonEvent;
}

/** Each subscriber told what is new for it once, and what settled since, so nobody hears a thing twice or never. */
export function sendWaiting(
  subscribers: ReadonlyMap<Peer, Set<string>>,
  waiting: readonly DaemonEvent[],
  routes: WaitingRoutes,
): void {
  const still = new Set(waiting.map((event) => event.subject));
  for (const [socket, told] of subscribers) {
    const phone = routes.phoneOf(socket);
    for (const event of waiting) {
      if (told.has(event.subject)) continue;
      told.add(event.subject);
      const origin = routes.originOf(event);
      const sent = waitingFor(event, {
        ...(phone === undefined ? {} : { phone }),
        ...(origin === undefined ? {} : { origin }),
        claimed: routes.claimed,
      });
      if (sent !== null) write(socket, { id: 0, ok: true, event: routes.stamp(sent) });
    }
    // Said, so a question answered in a terminal or a DM stops being asked out loud.
    for (const subject of [...told]) {
      if (still.has(subject)) continue;
      told.delete(subject);
      const done = settled(subject, routes.now);
      write(socket, { id: 0, ok: true, event: routes.stamp(done) });
    }
  }
}

export class OriginRouter {
  private readonly asks: Ask[] = [];
  private readonly claimed = new Set<string>();
  /** A show sent to the Mac for a phone, by subject, so its result goes back to that phone. */
  private readonly awaiting = new Map<string, { deviceId: string; event: DaemonEvent }>();

  constructor(private readonly deps: RouterDeps) {}

  /** A question began, from a phone or from the Mac, so a show raised after it is known to be its. */
  asked(deviceId: string | undefined, at: string): Ask {
    const ask: Ask = { at, ...(deviceId === undefined ? {} : { deviceId }) };
    this.asks.push(ask);
    if (this.asks.length > ASKS_KEPT) this.asks.shift();
    return ask;
  }

  /** Whether a phone's question is recent enough that a show may still be its, which keeps the feed running. */
  active(): boolean {
    const now = Date.parse(this.deps.now());
    return this.asks.some(
      (ask) =>
        ask.deviceId !== undefined &&
        (ask.endedAt === undefined || now - Date.parse(ask.endedAt) < ORIGIN_WINDOW_MS),
    );
  }

  /** The shows a phone's question raised, handled here and kept from every other subscriber. */
  async claim(
    events: readonly DaemonEvent[],
    mac: readonly Peer[],
  ): Promise<Set<string>> {
    for (const event of events) {
      if (this.claimed.has(event.subject) || event.needsMac !== true) continue;
      const deviceId = this.originOf(event.at);
      if (deviceId === undefined) continue;
      this.claimed.add(event.subject);
      await this.route(event, deviceId, mac);
    }
    return this.claimed;
  }

  /** A Mac proposal the phone signed: shown on the Mac now, its result owed to that phone. */
  async release(
    event: DaemonEvent,
    deviceId: string,
    mac: readonly Peer[],
  ): Promise<void> {
    if (mac.length === 0) {
      this.tellDone(deviceId, OPEN_THE_MAC);
      return;
    }
    this.awaiting.set(event.subject, { deviceId, event });
    const done = this.stamp({ ...markNeedsMac(event), origin: { deviceId } });
    for (const peer of mac) write(peer, { id: 0, ok: true, event: done });
  }

  /** The phone whose question raised a show, or undefined for the Mac's own and anything else. */
  originFor(event: DaemonEvent): string | undefined {
    return event.kind === DAEMON_EVENT.SHOW ? this.originOf(event.at) : undefined;
  }

  /** The Mac said how a show went, which the phone that asked for it now hears in a line. */
  async delivered(subject: string, outcome: string): Promise<void> {
    const owed = this.awaiting.get(subject);
    if (owed === undefined) return;
    this.awaiting.delete(subject);
    const name = await this.agentName(owed.event.agent);
    this.tellDone(owed.deviceId, doneText(owed.event, name, outcome));
  }

  private async route(
    event: DaemonEvent,
    deviceId: string,
    mac: readonly Peer[],
  ): Promise<void> {
    const device = await new Devices(this.deps.home).find(deviceId);
    if (device === null || mac.length === 0) {
      return this.refuse(event, deviceId, OPEN_THE_MAC, 'the Mac app is not open');
    }
    const reads = event.display !== undefined && MAC_READS.includes(event.display);
    if (reads || this.deps.driving(deviceId)) return this.release(event, deviceId, mac);
    if (!holds(device, REMOTE_CAPABILITY.MAC)) {
      return this.refuse(
        event,
        deviceId,
        NOT_ALLOWED_ON_MAC,
        `${device.name} may not act on the Mac`,
      );
    }
    await this.propose(event, device);
  }

  /** Held as a proposal for the phone to sign, and the brain told it waits on that phone. */
  private async propose(event: DaemonEvent, device: DeviceRecord): Promise<void> {
    const now = this.deps.now();
    await new Proposals(this.deps.home).propose({
      change: { kind: PROPOSAL_KIND.MAC, deviceId: device.id, event },
      rationale: macRationale(event, await this.agentName(event.agent)),
      proposedBy: PROPOSED_BY,
      at: now,
      ttlMs: MAC_PROPOSAL_TTL_MS,
    });
    await new DisplayRequests(this.deps.home).deliver(event.subject, {
      outcome: DELIVERY.WAITING,
      at: now,
      reason: `held until ${device.name} says yes`,
    });
  }

  /** Answered at once rather than held, so the brain stops waiting and the phone hears why. */
  private async refuse(
    event: DaemonEvent,
    deviceId: string,
    line: string,
    reason: string,
  ): Promise<void> {
    this.tellDone(deviceId, line);
    await new DisplayRequests(this.deps.home).deliver(event.subject, {
      outcome: DELIVERY.FAILED,
      at: this.deps.now(),
      reason,
    });
  }

  /** The device whose question a show raised: the latest question begun before it, if a phone asked it. */
  private originOf(at: string): string | undefined {
    const before = this.asks.filter((ask) => ask.at <= at).at(-1);
    if (before?.deviceId === undefined) return undefined;
    const ended = before.endedAt === undefined ? undefined : Date.parse(before.endedAt);
    return ended === undefined || Date.parse(at) - ended < ORIGIN_WINDOW_MS
      ? before.deviceId
      : undefined;
  }

  private stamp(event: DaemonEvent): DaemonEvent {
    return this.deps.stamp?.(event) ?? event;
  }

  private tellDone(deviceId: string, text: string): void {
    this.deps.tell(deviceId, { id: 0, ok: true, done: { text } });
  }

  private async agentName(agent: string): Promise<string> {
    const id = agent.startsWith(AGENT_ID_PREFIX) ? agent : `${AGENT_ID_PREFIX}${agent}`;
    return displayName(await readNames(this.deps.home), { id, kind: agent });
  }
}
