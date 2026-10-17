import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DAEMON_METHOD,
  decodeResponse,
  remoteCapabilityFor,
  type DaemonRequest,
  type DaemonResponse,
} from '@memnox/core';
import { answerConnections } from '../src/daemon/connection-calls';
import { isVoiceMethod } from '../src/daemon/voice-methods';
import { VoiceSurface } from '../src/daemon/voice-surface';
import { connectionsFrom, connectionsOf } from '../src/sync/personal-work';

/** A connection that keeps what it was sent, so the voice's side is tested with no socket. */
class Heard {
  destroyed = false;
  said: DaemonResponse[] = [];
  write(line: string): boolean {
    const response = decodeResponse(line.trim());
    if (response !== null) this.said.push(response);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

const REQUEST: DaemonRequest = { id: 9, method: DAEMON_METHOD.CONNECTIONS_LIST };

describe('the apps the person connected, folded from their sign ins', () => {
  it('keeps one entry per toolkit, connected when any sign in to it is active and enabled', () => {
    const connections = connectionsFrom([
      { id: 'g1', toolkit: 'slack', status: 'EXPIRED', enabled: true },
      { id: 'g2', toolkit: 'slack', status: 'ACTIVE', enabled: true },
      { id: 'g3', toolkit: 'gmail', status: 'active', enabled: true },
      { id: 'g4', toolkit: 'github', status: 'ACTIVE', enabled: false },
      { id: 'g5', toolkit: 'notion', status: 'INITIATED', enabled: true },
      { id: 'g6', toolkit: 'linear', status: 'FAILED', enabled: true },
    ]);

    expect(connections).toEqual([
      { toolkit: 'github', connected: false },
      { toolkit: 'gmail', connected: true },
      { toolkit: 'linear', connected: false },
      { toolkit: 'notion', connected: false },
      { toolkit: 'slack', connected: true },
    ]);
  });

  it('reads a sign in with no status or no enabled flag as not connected', () => {
    expect(
      connectionsFrom([
        { id: 'g1', toolkit: 'gmail', enabled: true },
        { id: 'g2', toolkit: 'slack', status: 'ACTIVE' },
      ]),
    ).toEqual([
      { toolkit: 'gmail', connected: false },
      { toolkit: 'slack', connected: false },
    ]);
  });

  it('lists nothing when there are no sign ins', () => {
    expect(connectionsFrom([])).toEqual([]);
  });
});

describe('the connections-list request the Mac menu bar sends', () => {
  it('says in plain words that nobody is signed in, rather than throwing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-connections-'));

    const answer = await connectionsOf(home);

    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.said).toMatch(/not signed in as you/);
  });

  it('answers the refusal over the socket with a reason', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-connections-surface-'));
    const surface = new VoiceSurface({ home, now: () => 'now', log: () => undefined });
    const peer = new Heard();

    await surface.respond(peer, REQUEST);
    surface.close();

    expect(peer.said[0]).toMatchObject({ id: 9, ok: false });
    expect(peer.said[0]?.reason).toMatch(/not signed in as you/);
    expect(peer.said[0]?.connections).toBeUndefined();
  });

  it('carries the connections when the workspace answered', async () => {
    const response = await answerConnections(REQUEST, '/nowhere', async () => ({
      ok: true,
      value: [{ toolkit: 'gmail', connected: true }],
    }));

    expect(response).toEqual({
      id: 9,
      ok: true,
      connections: [{ toolkit: 'gmail', connected: true }],
    });
  });

  it('passes the workspace refusal on as the reason', async () => {
    const response = await answerConnections(REQUEST, '/nowhere', async () => ({
      ok: false,
      said: 'Your sign in to this workspace ended.',
      status: 401,
    }));

    expect(response).toEqual({
      id: 9,
      ok: false,
      reason: 'Your sign in to this workspace ended.',
    });
  });

  it('turns an unplanned failure into a sentence', async () => {
    const response = await answerConnections(REQUEST, '/nowhere', async () => {
      throw new Error('boom');
    });

    expect(response).toEqual({
      id: 9,
      ok: false,
      reason: 'Your connected apps could not be listed just now.',
    });
  });

  it('is the Mac app’s to ask and a paired phone’s to see', () => {
    expect(isVoiceMethod(DAEMON_METHOD.CONNECTIONS_LIST)).toBe(true);
    expect(remoteCapabilityFor(DAEMON_METHOD.CONNECTIONS_LIST)).toBe('see');
  });
});
