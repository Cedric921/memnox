import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ConfirmKeys,
  DAEMON_METHOD,
  Devices,
  driveMessage,
  pairMessage,
  PROPOSAL_KIND,
  Proposals,
  REMOTE_OUTCOME,
  THIS_MAC,
  type DaemonRequest,
  type DaemonResponse,
  type DrivenBy,
  voiceListening,
} from '@memnox/core';
import type { Peer } from '../src/daemon/socket-write';
import { VoiceSurface } from '../src/daemon/voice-surface';
import { RemoteEndpoint } from '../src/remote/endpoint';
import { FRAME, frame } from '../src/remote/framing';
import { loadNoise } from '../src/remote/noise';
import type { QrPayload } from '../src/remote/pairing';
import {
  ACCOUNT,
  MAILBOX,
  MemoryRelay,
  memoryCloud,
  personKey,
  Phone,
  settle,
  type PersonKey,
} from './phone-harness';

/**
 * Pairing a phone and talking through its tunnel, with the real snow addon and an in memory relay.
 * The digits only let the person compare screens; nothing is written until the Mac signs.
 */

const NOW = '2026-10-05T10:00:00.000Z';

/** One sample of 16 bit mono PCM at 24000 Hz, as the Mac's Kokoro would answer a line. */
const ONE_SAMPLE_WAV = Buffer.from(
  '524946462600000057415645666d74201000000001000100c05d000080bb0000020010006461746102000000' +
    '0100',
  'hex',
);

/** A connection that keeps every line written to it. */
class Lines implements Peer {
  destroyed = false;
  readonly lines: DaemonResponse[] = [];
  write(line: string): void {
    this.lines.push(JSON.parse(line) as DaemonResponse);
  }
  destroy(): void {
    this.destroyed = true;
  }
}

interface Rig {
  home: string;
  endpoint: RemoteEndpoint;
  relay: MemoryRelay;
  cloud: ReturnType<typeof memoryCloud>;
  mac: PersonKey;
  voice: VoiceSurface;
  ask: (request: Omit<DaemonRequest, 'id'>) => Promise<DaemonResponse>;
}

async function rig(enrolled = true, macKey = true): Promise<Rig> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-remote-'));
  const mac = personKey();
  if (macKey) await new ConfirmKeys(home).register(mac.point, NOW);
  const relay = new MemoryRelay();
  const cloud = memoryCloud();
  let voice: VoiceSurface | null = null;
  const endpoint = new RemoteEndpoint({
    home,
    now: () => NOW,
    log: () => undefined,
    voice: () => voice,
    cloud,
    openRelay: relay.open,
    account: async () => (enrolled ? ACCOUNT : null),
    speaks: async () => true,
  });
  const surface = new VoiceSurface({
    home,
    now: () => NOW,
    log: () => undefined,
    feedIntervalMs: 60_000,
    render: () => Promise.resolve(new Response(ONE_SAMPLE_WAV)),
    remote: {
      driving: (id) => endpoint.driving(id),
      tell: (id, response) => endpoint.tell(id, response),
    },
  });
  voice = surface;
  let next = 1;
  async function ask(request: Omit<DaemonRequest, 'id'>): Promise<DaemonResponse> {
    const peer = new Lines();
    await endpoint.respondLocal(peer, { ...request, id: next++ } as DaemonRequest);
    const [first] = peer.lines;
    if (first === undefined) throw new Error('no answer');
    return first;
  }
  return { home, endpoint, relay, cloud, mac, voice: surface, ask };
}

function qrOf(response: DaemonResponse): QrPayload {
  const link = response.pairing?.qr ?? '';
  return JSON.parse(
    Buffer.from(link.split('d=')[1] ?? '', 'base64url').toString(),
  ) as QrPayload;
}

/** Pair-begin, then the phone's whole handshake and proof, up to the digits on both screens. */
async function answered(
  at: Rig,
  kind?: string,
): Promise<{ phone: Phone; qr: QrPayload; pairingId: string; watch: Lines }> {
  const begun = await at.ask({ method: DAEMON_METHOD.PAIR_BEGIN, name: 'Studio Mac' });
  const qr = qrOf(begun);
  const pairingId = begun.pairing?.id ?? '';
  await settle(() => at.relay.up);
  const phone = new Phone(at.relay);
  phone.startPairing(Buffer.from(qr.secret, 'base64'));
  const reply = at.relay.payloads(MAILBOX).at(-1) ?? Buffer.alloc(0);
  const said = phone.finishPairing(reply, kind === 'desktop' ? 'Studio' : 'iPhone', kind);
  expect(said.machine).toBe('Studio Mac');
  expect(said.runtimeStatic?.toString('base64')).toBe(qr.runtimeNoiseStatic);
  const watch = new Lines();
  await at.endpoint.respondLocal(watch, {
    id: 90,
    method: DAEMON_METHOD.PAIR_PENDING,
    pairingId,
  });
  return { phone, qr, pairingId, watch };
}

describe('pairing a phone', () => {
  it('is refused with a reason when this Mac is not on Memnox Cloud', async () => {
    const at = await rig(false);
    const answer = await at.ask({ method: DAEMON_METHOD.PAIR_BEGIN });

    expect(answer).toMatchObject({ ok: false, outcome: REMOTE_OUTCOME.REFUSED });
    expect(answer.reason).toContain('memnox login');
    expect(at.cloud.calls).toEqual([]);
  });

  it('opens a QR that names the relay, the mailbox and the runtime key, and nothing lasting', async () => {
    const at = await rig();
    const begun = await at.ask({ method: DAEMON_METHOD.PAIR_BEGIN });
    const qr = qrOf(begun);
    await settle(() => at.relay.up);

    expect(begun.outcome).toBe(REMOTE_OUTCOME.PAIRING);
    expect(begun.pairing?.qr).toMatch(/^memnox:\/\/pair\?d=/);
    expect(qr).toMatchObject({
      v: 1,
      machineId: 'mac_1',
      mailbox: MAILBOX,
      pairingToken: 'rlp_test',
    });
    expect(Buffer.from(qr.secret, 'base64')).toHaveLength(32);
    expect(at.relay.opened).toBe(1);
  });

  it('shows the same six digits on both screens once the phone proves its key', async () => {
    const at = await rig();
    const { phone, watch } = await answered(at);
    await settle();
    const last = watch.lines.at(-1);

    expect(last?.pairing?.state).toBe('answered');
    expect(last?.pairing?.phone?.name).toBe('iPhone');
    expect(last?.pairing?.phone?.code).toBe(
      loadNoise().pairingCode(phone.hash ?? Buffer.alloc(4)),
    );
  });

  it('writes no device on matching digits alone, nor on a signature that is not the Mac', async () => {
    const at = await rig();
    const { pairingId, watch } = await answered(at);
    const fingerprint = watch.lines.at(-1)?.pairing?.phone?.fingerprint ?? '';

    const bare = await at.ask({ method: DAEMON_METHOD.PAIR_ACCEPT, pairingId });
    const forged = await at.ask({
      method: DAEMON_METHOD.PAIR_ACCEPT,
      pairingId,
      signature: personKey().signs(pairMessage(pairingId, fingerprint)),
    });

    expect(bare.outcome).toBe(REMOTE_OUTCOME.REFUSED);
    expect(forged.outcome).toBe(REMOTE_OUTCOME.REFUSED);
    expect((await new Devices(at.home).all()).map((each) => each.id)).toEqual([THIS_MAC]);
    expect(at.cloud.calls).not.toContain(`mint ${MAILBOX}`);
  });

  it('pairs on the Mac signature, mints the phone its token, and tells the phone', async () => {
    const at = await rig();
    const { phone, pairingId, watch } = await answered(at);
    const fingerprint = watch.lines.at(-1)?.pairing?.phone?.fingerprint ?? '';
    const sent = at.relay.payloads(MAILBOX).length;

    const accepted = await at.ask({
      method: DAEMON_METHOD.PAIR_ACCEPT,
      pairingId,
      signature: at.mac.signs(pairMessage(pairingId, fingerprint)),
    });

    expect(accepted).toMatchObject({ ok: true, outcome: REMOTE_OUTCOME.PAIRED });
    expect(accepted.device).toMatchObject({ name: 'iPhone', kind: 'phone', fingerprint });
    expect(accepted.device?.capabilities).toEqual(['see', 'ask', 'answer', 'steer']);
    expect(phone.read(at.relay.payloads(MAILBOX).slice(sent))).toEqual([
      {
        paired: true,
        deviceId: accepted.device?.id,
        relayToken: 'rly_test',
        voice: 'af_heart',
        speaks: true,
      },
    ]);
    expect(watch.lines.at(-1)?.pairing?.state).toBe('paired');
  });
});

describe('pairing on a machine with no Mac key, such as a server reached over SSH', () => {
  it('opens a pairing the person accepts at the shell, and keeps the digits off the socket', async () => {
    const at = await rig(true, false);
    const { watch } = await answered(at);
    await settle();
    const last = watch.lines.at(-1);

    expect(last?.pairing?.state).toBe('answered');
    expect(last?.pairing?.approver).toBe('local-shell');
    expect(last?.pairing?.phone?.name).toBe('iPhone');
    expect(last?.pairing?.phone).not.toHaveProperty('code');
  });

  it('pairs on the digits the device shows, and records the shell as what let it through', async () => {
    const at = await rig(true, false);
    const { phone, pairingId } = await answered(at);
    const code = loadNoise().pairingCode(phone.hash ?? Buffer.alloc(4));

    const accepted = await at.ask({ method: DAEMON_METHOD.PAIR_ACCEPT, pairingId, code });

    expect(accepted).toMatchObject({ ok: true, outcome: REMOTE_OUTCOME.PAIRED });
    expect(accepted.device).toMatchObject({ kind: 'phone', approvedBy: 'local-shell' });
    const [device] = await new Devices(at.home).all();
    expect(device?.approvedBy).toBe('local-shell');
  });

  it('closes the pairing after three wrong codes, so six digits cannot be walked', async () => {
    const at = await rig(true, false);
    const { phone, pairingId, watch } = await answered(at);
    const code = loadNoise().pairingCode(phone.hash ?? Buffer.alloc(4));
    const wrong = code === '000000' ? '111111' : '000000';

    const first = await at.ask({
      method: DAEMON_METHOD.PAIR_ACCEPT,
      pairingId,
      code: wrong,
    });
    await at.ask({ method: DAEMON_METHOD.PAIR_ACCEPT, pairingId, code: wrong });
    const third = await at.ask({
      method: DAEMON_METHOD.PAIR_ACCEPT,
      pairingId,
      code: wrong,
    });
    const late = await at.ask({ method: DAEMON_METHOD.PAIR_ACCEPT, pairingId, code });

    expect(first.reason).toContain('2 tries left');
    expect(third.reason).toContain('closed');
    expect(late.outcome).toBe(REMOTE_OUTCOME.REFUSED);
    expect(watch.lines.at(-1)?.pairing?.state).toBe('declined');
    expect(await new Devices(at.home).all()).toEqual([]);
  });

  it('asks for Touch ID instead of digits once a Mac key is registered', async () => {
    const at = await rig(true, false);
    const { phone, pairingId } = await answered(at);
    await new ConfirmKeys(at.home).register(at.mac.point, NOW);

    const typed = await at.ask({
      method: DAEMON_METHOD.PAIR_ACCEPT,
      pairingId,
      code: loadNoise().pairingCode(phone.hash ?? Buffer.alloc(4)),
    });

    expect(typed.outcome).toBe(REMOTE_OUTCOME.REFUSED);
    expect(typed.reason).toContain('Touch ID');
  });

  it('pairs a Mac reaching it through the relay as a desktop, with what a phone holds', async () => {
    const at = await rig(true, false);
    const { phone, pairingId } = await answered(at, 'desktop');
    const code = loadNoise().pairingCode(phone.hash ?? Buffer.alloc(4));

    const accepted = await at.ask({ method: DAEMON_METHOD.PAIR_ACCEPT, pairingId, code });

    expect(accepted.device).toMatchObject({ name: 'Studio', kind: 'desktop' });
    expect(accepted.device?.capabilities).toEqual(['see', 'ask', 'answer', 'steer']);
  });

  it('gives a device more on the word of this socket alone', async () => {
    const at = await rig(true, false);
    const { phone, pairingId } = await answered(at);
    const code = loadNoise().pairingCode(phone.hash ?? Buffer.alloc(4));
    const accepted = await at.ask({ method: DAEMON_METHOD.PAIR_ACCEPT, pairingId, code });

    const granted = await at.ask({
      method: DAEMON_METHOD.DEVICE_GRANT,
      deviceId: accepted.device?.id ?? '',
      capability: 'rules',
    });

    expect(granted.outcome).toBe(REMOTE_OUTCOME.GRANTED);
    expect(granted.device?.capabilities).toContain('rules');
  });
});

/** A rig with one phone paired through the whole ceremony, and its tunnel open. */
async function paired(): Promise<
  Rig & { phone: Phone; runtimeStatic: Buffer; deviceId: string }
> {
  const at = await rig();
  const { phone, qr, pairingId, watch } = await answered(at);
  const fingerprint = watch.lines.at(-1)?.pairing?.phone?.fingerprint ?? '';
  const accepted = await at.ask({
    method: DAEMON_METHOD.PAIR_ACCEPT,
    pairingId,
    signature: at.mac.signs(pairMessage(pairingId, fingerprint)),
  });
  const runtimeStatic = Buffer.from(qr.runtimeNoiseStatic, 'base64');
  await open(at.relay, phone, runtimeStatic);
  return { ...at, phone, runtimeStatic, deviceId: accepted.device?.id ?? '' };
}

async function open(
  relay: MemoryRelay,
  phone: Phone,
  runtimeStatic: Buffer,
): Promise<void> {
  const before = relay.payloads(MAILBOX).length;
  phone.startSession(runtimeStatic);
  await settle(() => relay.payloads(MAILBOX).length > before);
  const reply = relay
    .payloads(MAILBOX)
    .slice(before)
    .find((each) => each[0] === FRAME.HANDSHAKE);
  if (reply === undefined) throw new Error('the runtime never answered the handshake');
  phone.finishSession(reply);
}

/** What the phone hears after sending one request through its tunnel. */
async function through(
  at: Rig & { phone: Phone },
  request: DaemonRequest,
): Promise<unknown[]> {
  const before = at.relay.payloads(MAILBOX).length;
  at.phone.send(request);
  await settle(() => at.relay.payloads(MAILBOX).length > before);
  return at.phone.read(at.relay.payloads(MAILBOX).slice(before));
}

describe('a paired phone through its tunnel', () => {
  it('answers a request it may make, under the device its handshake proved', async () => {
    const at = await paired();
    const heard = await through(at, { id: 7, method: DAEMON_METHOD.PING });

    expect(heard).toEqual([expect.objectContaining({ id: 7, ok: true, speaks: true })]);
  });

  it('tells the phone on its ping what it may do here, and changing rules is not among it', async () => {
    const at = await paired();
    // The tunnel hands back plain JSON, read here as the response it is.
    const [heard] = (await through(at, {
      id: 12,
      method: DAEMON_METHOD.PING,
    })) as DaemonResponse[];

    expect(heard?.capabilities).toEqual(expect.arrayContaining(['see', 'answer']));
    expect(heard?.capabilities).not.toContain('rules');
  });

  it('refuses a method off the allowlist, and one its capabilities do not cover', async () => {
    const at = await paired();
    const local = await through(at, {
      id: 8,
      method: DAEMON_METHOD.REGISTER_KEY,
      point: 'x',
    });
    const drive = await through(at, { id: 9, method: DAEMON_METHOD.DRIVE, until: NOW });
    const voice = await through(at, {
      id: 10,
      method: DAEMON_METHOD.VOICE_CHOICE,
      voice: 'af_bella',
    });

    for (const heard of [local, drive, voice]) {
      expect(heard).toEqual([expect.objectContaining({ ok: false, outcome: 'refused' })]);
    }
  });

  it('keeps the session an ask names, and sets the origin itself whatever the phone wrote', async () => {
    const at = await paired();
    const respond = vi.spyOn(at.voice, 'respond');
    await through(at, {
      id: 11,
      method: DAEMON_METHOD.ASK,
      said: 'tell it to run the tests again',
      sessionId: 'ses_open',
      origin: { deviceId: 'dev_someone_else' },
    });

    const asked = respond.mock.calls[0]?.[1];
    expect(asked?.sessionId).toBe('ses_open');
    expect(asked?.origin).toBeUndefined();
    expect(respond.mock.calls[0]?.[2]?.device.id).toBe(at.deviceId);
  });

  it('drops a handshake from a key never paired, even on a mailbox with a valid token', async () => {
    const at = await paired();
    const stranger = new Phone(at.relay);
    const before = at.relay.payloads(MAILBOX).length;
    stranger.startSession(at.runtimeStatic);
    await settle();

    expect(at.relay.payloads(MAILBOX).length).toBe(before);
  });

  it('drops a transport frame that comes before any handshake', async () => {
    const at = await paired();
    const other = Buffer.alloc(16, 9).toString('base64url');
    at.relay.deliver(
      other,
      Buffer.concat([Buffer.from([FRAME.TRANSPORT]), Buffer.alloc(40, 1)]),
    );
    await settle();

    expect(at.relay.payloads(other)).toEqual([]);
  });

  it('closes the live session the moment the phone is revoked, and refuses it after', async () => {
    const at = await paired();
    const before = at.relay.payloads(MAILBOX).length;
    const revoked = await at.ask({
      method: DAEMON_METHOD.DEVICE_REVOKE,
      deviceId: at.deviceId,
    });

    expect(revoked.outcome).toBe(REMOTE_OUTCOME.REVOKED);
    expect(
      at.relay
        .payloads(MAILBOX)
        .slice(before)
        .map((each) => each[0]),
    ).toContain(FRAME.CLOSE);
    expect(at.cloud.calls).toContain(`close ${MAILBOX}`);
    const after = at.relay.payloads(MAILBOX).length;
    at.phone.startSession(at.runtimeStatic);
    await settle();
    expect(at.relay.payloads(MAILBOX).length).toBe(after);
  });

  it('gives a capability only with the Mac signature over exactly that grant', async () => {
    const at = await paired();
    const unsigned = await at.ask({
      method: DAEMON_METHOD.DEVICE_GRANT,
      deviceId: at.deviceId,
      capability: 'mac',
    });
    const granted = await at.ask({
      method: DAEMON_METHOD.DEVICE_GRANT,
      deviceId: at.deviceId,
      capability: 'mac',
      signature: at.mac.signs(`memnox-grant:v1:${at.deviceId}:mac`),
    });

    expect(unsigned.outcome).toBe(REMOTE_OUTCOME.REFUSED);
    expect(granted.outcome).toBe(REMOTE_OUTCOME.GRANTED);
    expect((await new Devices(at.home).find(at.deviceId))?.capabilities).toContain('mac');
  });

  it('takes the hourly handshake again on the same mailbox', async () => {
    const at = await paired();
    await open(at.relay, at.phone, at.runtimeStatic);

    expect(await through(at, { id: 11, method: DAEMON_METHOD.PING })).toEqual([
      expect.objectContaining({ id: 11, ok: true }),
    ]);
  });

  it('wakes the phone when something new waits and its tunnel is closed, once', async () => {
    const at = await paired();
    const proposals = new Proposals(at.home);
    const resume = { kind: PROPOSAL_KIND.RESUME, sessionId: 'ses_1' } as const;
    await proposals.propose({
      change: resume,
      rationale: 'r',
      proposedBy: 'memnox',
      at: NOW,
      ttlMs: 60_000,
    });
    expect(await at.endpoint.wakePhones()).toBe(0);

    at.relay.drop();
    await settle();
    const later = { kind: PROPOSAL_KIND.RESUME, sessionId: 'ses_2' } as const;
    await proposals.propose({
      change: later,
      rationale: 'r',
      proposedBy: 'memnox',
      at: NOW,
      ttlMs: 60_000,
    });

    expect(await at.endpoint.wakePhones()).toBe(1);
    expect(at.cloud.calls).toContain(`wake ${MAILBOX}`);
    expect(await at.endpoint.wakePhones()).toBe(0);
  });
});

const UNTIL = '2026-10-05T10:10:00.000Z';

/** A paired phone allowed onto the Mac and driving it, with the Mac app subscribed to hear who drives. */
async function driving(): Promise<
  Rig & { phone: Phone; runtimeStatic: Buffer; deviceId: string; island: Lines }
> {
  const at = await paired();
  await at.ask({
    method: DAEMON_METHOD.DEVICE_GRANT,
    deviceId: at.deviceId,
    capability: 'mac',
    signature: at.mac.signs(`memnox-grant:v1:${at.deviceId}:mac`),
  });
  const island = new Lines();
  await at.voice.respond(island, { id: 1, method: DAEMON_METHOD.SUBSCRIBE });
  const drove = await through(at, {
    id: 20,
    method: DAEMON_METHOD.DRIVE,
    until: UNTIL,
    signature: at.phone.key.signs(driveMessage(at.deviceId, UNTIL)),
  });
  expect(drove).toEqual([expect.objectContaining({ outcome: REMOTE_OUTCOME.DRIVING })]);
  return { ...at, island };
}

function drivenOn(island: Lines): DrivenBy[] {
  return island.lines.flatMap((each) =>
    each.event?.drivenBy === undefined ? [] : [each.event.drivenBy],
  );
}

/** The one stop signal the contract names: the phone, and no until. */
function stoppedOnce(at: Rig & { deviceId: string; island: Lines }): void {
  const told = drivenOn(at.island);
  expect(told[0]).toEqual({ deviceId: at.deviceId, name: 'iPhone', until: UNTIL });
  expect(told.slice(1)).toEqual([{ deviceId: at.deviceId, name: 'iPhone' }]);
  expect(at.endpoint.driving(at.deviceId)).toBe(false);
  at.voice.close();
}

describe('a drive that ends early tells the Mac with no until', () => {
  it('on a drive with no until', async () => {
    const at = await driving();
    const stopped = await through(at, { id: 21, method: DAEMON_METHOD.DRIVE });

    expect(stopped).toEqual([
      expect.objectContaining({ outcome: REMOTE_OUTCOME.STOPPED }),
    ]);
    stoppedOnce(at);
  });

  it("on the phone's close message", async () => {
    const at = await driving();
    at.relay.deliver(MAILBOX, frame(FRAME.CLOSE));
    await settle(() => !at.endpoint.driving(at.deviceId));

    stoppedOnce(at);
  });

  it('when the relay drops the session', async () => {
    const at = await driving();
    at.relay.drop();
    await settle(() => !at.endpoint.driving(at.deviceId));

    stoppedOnce(at);
  });

  it('on a revoke, once although its session closes too', async () => {
    const at = await driving();
    await at.ask({ method: DAEMON_METHOD.DEVICE_REVOKE, deviceId: at.deviceId });

    stoppedOnce(at);
  });

  it('on taking mac back, which answers ungranted with the device', async () => {
    const at = await driving();
    const ungranted = await at.ask({
      method: DAEMON_METHOD.DEVICE_UNGRANT,
      deviceId: at.deviceId,
      capability: 'mac',
    });

    expect(ungranted).toMatchObject({ ok: true, outcome: REMOTE_OUTCOME.UNGRANTED });
    expect(ungranted.device?.capabilities).toEqual(['see', 'ask', 'answer', 'steer']);
    expect((await new Devices(at.home).find(at.deviceId))?.capabilities).not.toContain(
      'mac',
    );
    stoppedOnce(at);
  });
});

describe('taking one capability back', () => {
  it('needs no signature, keeps a drive going when it is not mac, and refuses what it does not know', async () => {
    const at = await driving();
    const steer = await at.ask({
      method: DAEMON_METHOD.DEVICE_UNGRANT,
      deviceId: at.deviceId,
      capability: 'steer',
    });
    const unknown = await at.ask({
      method: DAEMON_METHOD.DEVICE_UNGRANT,
      deviceId: at.deviceId,
      capability: 'everything',
    });
    const stranger = await at.ask({
      method: DAEMON_METHOD.DEVICE_UNGRANT,
      deviceId: 'dev_nobody',
      capability: 'see',
    });
    at.voice.close();

    expect(steer.outcome).toBe(REMOTE_OUTCOME.UNGRANTED);
    expect(steer.device?.capabilities).toEqual(['see', 'ask', 'answer', 'mac']);
    expect(at.endpoint.driving(at.deviceId)).toBe(true);
    expect(drivenOn(at.island)).toHaveLength(1);
    expect(unknown.outcome).toBe(REMOTE_OUTCOME.REFUSED);
    expect(stranger.outcome).toBe(REMOTE_OUTCOME.REFUSED);
  });

  it('is never answered from afar', async () => {
    const at = await paired();
    const heard = await through(at, {
      id: 30,
      method: DAEMON_METHOD.DEVICE_UNGRANT,
      deviceId: at.deviceId,
      capability: 'see',
    });

    expect(heard).toEqual([expect.objectContaining({ outcome: REMOTE_OUTCOME.REFUSED })]);
    expect((await new Devices(at.home).find(at.deviceId))?.capabilities).toContain('see');
  });
});

describe('a phone with its app open', () => {
  it('holds the voice while its stream lives, and for the grace after the session drops', async () => {
    const at = await paired();
    const subscribed = await through(at, { id: 40, method: DAEMON_METHOD.SUBSCRIBE });
    expect(subscribed).toEqual([expect.objectContaining({ id: 40, ok: true })]);
    expect(at.voice.hold.holder()?.deviceId).toBe(at.deviceId);

    const ended = vi.spyOn(at.voice.hold, 'unsubscribed');
    at.relay.drop();
    await settle(() => ended.mock.calls.length > 0);
    expect(ended).toHaveBeenCalledWith(at.deviceId);
    expect(at.voice.hold.holder()?.deviceId).toBe(at.deviceId);
    at.voice.close();
  });

  it('makes a held call wait for its answer, since nobody may be at the terminal at all', async () => {
    const at = await paired();
    expect(await voiceListening(at.home)).toBe(false);

    await through(at, { id: 42, method: DAEMON_METHOD.SUBSCRIBE });
    let listening = false;
    for (let tries = 0; tries < 50 && !listening; tries++) {
      listening = await voiceListening(at.home);
      if (!listening) await settle();
    }

    expect(listening).toBe(true);
    at.voice.close();
  });

  it('gives the voice back the moment it is revoked', async () => {
    const at = await paired();
    await through(at, { id: 41, method: DAEMON_METHOD.SUBSCRIBE });
    await at.ask({ method: DAEMON_METHOD.DEVICE_REVOKE, deviceId: at.deviceId });

    expect(at.voice.hold.holder()).toBeNull();
    at.voice.close();
  });
});

describe('browsing the Mac from a phone', () => {
  it('lists a folder under see, without the brain', async () => {
    const at = await paired();
    await mkdir(join(at.home, 'Projects'));
    const heard = await through(at, { id: 50, method: DAEMON_METHOD.FILES_LIST });

    expect(heard).toEqual([
      expect.objectContaining({
        id: 50,
        ok: true,
        path: '',
        files: [expect.objectContaining({ name: 'Projects', kind: 'folder' })],
      }),
    ]);
  });

  it('is refused once see is taken back', async () => {
    const at = await paired();
    await at.ask({
      method: DAEMON_METHOD.DEVICE_UNGRANT,
      deviceId: at.deviceId,
      capability: 'see',
    });
    const heard = await through(at, { id: 51, method: DAEMON_METHOD.FILES_LIST });

    expect(heard).toEqual([
      expect.objectContaining({ ok: false, outcome: REMOTE_OUTCOME.REFUSED }),
    ]);
  });
});

describe("hearing a line from the Mac in the person's own voice", () => {
  it('renders it under ask and streams it to the phone', async () => {
    const at = await paired();
    const heard = await through(at, {
      id: 60,
      method: DAEMON_METHOD.SPEAK,
      line: 'Your build passed.',
    });

    expect(heard).toEqual([
      { id: 60, ok: true, audio: { rate: 24_000, samples: 'AQA=', last: true } },
    ]);
  });

  it('is refused once ask is taken back', async () => {
    const at = await paired();
    await at.ask({
      method: DAEMON_METHOD.DEVICE_UNGRANT,
      deviceId: at.deviceId,
      capability: 'ask',
    });
    const heard = await through(at, { id: 61, method: DAEMON_METHOD.SPEAK, line: 'Hi.' });

    expect(heard).toEqual([
      expect.objectContaining({ ok: false, outcome: REMOTE_OUTCOME.REFUSED }),
    ]);
  });
});
