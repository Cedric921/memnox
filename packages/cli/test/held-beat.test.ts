import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isBeatFrame,
  RelayLink,
  type OpenRelay,
  type RelaySocket,
} from '../src/remote/relay-link';
import { HeartbeatBeats } from '../src/sync/beat';
import { syncLoop } from '../src/sync/heartbeat';
import { RELAYED_HELD_POLL_MS } from '../src/sync/pace';

/**
 * While a call is held, a machine with a live relay link waits for the control plane's beat
 * rather than polling every two seconds, and a machine without one polls exactly as before.
 */

afterEach(() => {
  vi.useRealTimers();
});

function linkedBeats(up: boolean): HeartbeatBeats {
  const beats = new HeartbeatBeats();
  beats.linkedBy(() => up);
  return beats;
}

describe('the held poll with a relay link', () => {
  it('relaxes to the slow fallback once the held call has been carried up', async () => {
    const slept: number[] = [];
    let left = 1;

    await syncLoop('/home', () => left-- > 0, {
      pass: async () => ({}),
      sleep: async (ms) => {
        slept.push(ms);
      },
      holding: async () => ['call_1'],
      active: async () => false,
      beats: linkedBeats(true),
    });

    expect(slept.reduce((total, ms) => total + ms, 0)).toBe(RELAYED_HELD_POLL_MS);
  });

  it('still carries a new question up within two seconds', async () => {
    const slept: number[] = [];
    let reads = 0;
    let left = 1;

    await syncLoop('/home', () => left-- > 0, {
      pass: async () => ({}),
      sleep: async (ms) => {
        slept.push(ms);
      },
      // Nothing held when the pass ran, then an agent stops on a question.
      holding: async () => (reads++ === 0 ? [] : ['call_1']),
      active: async () => false,
      beats: linkedBeats(true),
    });

    expect(slept).toEqual([2_000]);
  });

  it('beats at once when the control plane says an answer is waiting', async () => {
    const beats = linkedBeats(true);
    const slept: number[] = [];
    let left = 1;

    await syncLoop('/home', () => left-- > 0, {
      pass: async () => ({}),
      sleep: async (ms) => {
        slept.push(ms);
        if (slept.length === 3) beats.beat();
      },
      holding: async () => ['call_1'],
      active: async () => false,
      beats,
    });

    expect(slept).toEqual([2_000, 2_000, 2_000]);
  });

  it('ignores a beat with nothing held, since no answer could be for this machine', async () => {
    const beats = linkedBeats(true);
    const slept: number[] = [];
    let left = 1;

    await syncLoop('/home', () => left-- > 0, {
      pass: async () => ({}),
      sleep: async (ms) => {
        slept.push(ms);
        beats.beat();
      },
      holding: async () => [],
      active: async () => false,
      beats,
    });

    expect(slept.reduce((total, ms) => total + ms, 0)).toBe(60_000);
  });

  it('keeps the two second poll while the link is down', async () => {
    const slept: number[] = [];
    let left = 2;

    await syncLoop('/home', () => left-- > 0, {
      pass: async () => ({}),
      sleep: async (ms) => {
        slept.push(ms);
      },
      holding: async () => ['call_1'],
      active: async () => false,
      beats: linkedBeats(false),
    });

    expect(slept).toEqual([2_000, 2_000]);
  });
});

describe('the beat signal', () => {
  it('cuts a sleep short, and is taken once', async () => {
    vi.useFakeTimers();
    const beats = new HeartbeatBeats(() => Date.now());
    let woke = false;
    void beats.sleep(30_000).then(() => {
      woke = true;
    });

    beats.beat();
    await vi.advanceTimersByTimeAsync(0);

    expect(woke).toBe(true);
    expect(beats.take()).toBe(true);
    expect(beats.take()).toBe(false);
  });

  it('holds a burst to one wake a second, without losing the beat', async () => {
    vi.useFakeTimers();
    const beats = new HeartbeatBeats(() => Date.now());
    beats.beat();
    expect(beats.take()).toBe(true);
    let woke = false;
    void beats.sleep(30_000).then(() => {
      woke = true;
    });

    beats.beat();
    await vi.advanceTimersByTimeAsync(500);
    expect(woke).toBe(false);
    await vi.advanceTimersByTimeAsync(500);

    expect(woke).toBe(true);
    expect(beats.take()).toBe(true);
  });
});

describe('the relay link hearing a beat', () => {
  function fakeRelay(): {
    open: OpenRelay;
    text: (body: string) => void;
    frame: (data: Buffer) => void;
  } {
    const listeners = new Map<string, (data: Buffer) => void>();
    const socket: RelaySocket = {
      send: () => undefined,
      close: () => undefined,
      on: (event: string, listener: (data: Buffer) => void) => {
        listeners.set(event, listener);
        if (event === 'open') queueMicrotask(() => listener(Buffer.alloc(0)));
      },
    };
    return {
      open: () => socket,
      text: (body) => listeners.get('text')?.(Buffer.from(body, 'utf8')),
      frame: (data) => listeners.get('message')?.(data),
    };
  }

  it('beats on the relay text frame and on nothing else', async () => {
    const relay = fakeRelay();
    const onBeat = vi.fn();
    const onFrame = vi.fn();
    new RelayLink({
      url: 'ws://127.0.0.1:8787/v1/relay',
      token: 'mch_test',
      onFrame,
      onDown: () => undefined,
      onBeat,
      log: () => undefined,
      open: relay.open,
    }).start();
    await Promise.resolve();

    relay.text('{"type":"beat"}');
    relay.text('{"type":"something-newer"}');
    relay.text('not json');
    // The same bytes as binary are mailbox traffic, never a beat.
    relay.frame(Buffer.from('{"type":"beat"}'));

    expect(onBeat).toHaveBeenCalledTimes(1);
  });

  it('reads only the beat it knows', () => {
    expect(isBeatFrame('{"type":"beat"}')).toBe(true);
    expect(isBeatFrame('{"type":"beat","call":"x"}')).toBe(true);
    expect(isBeatFrame('null')).toBe(false);
    expect(isBeatFrame('"beat"')).toBe(false);
  });
});
