import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SessionTasks,
  SessionTurns,
  SqliteEventStore,
  type MemnoxEvent,
} from '@memnox/core';
import { SessionViews } from '../src/daemon/session-view';

const NOW = new Date('2026-10-02T12:00:00.000Z');

function row(over: Partial<MemnoxEvent>): MemnoxEvent {
  return {
    id: `evt_${over.at ?? ''}`,
    schemaVersion: 1,
    at: '2026-10-02T11:58:00.000Z',
    sessionId: 'ses_live',
    agent: 'claude-code',
    actorType: 'agent',
    surface: 'filesystem',
    operation: 'file.edit',
    class: 'write',
    effect: 'allow',
    mode: 'enforce',
    reason: 'no rule matched',
    ...over,
  };
}

describe('the live window on a session', () => {
  it('says what it is on, what it just did in words, and marks what was refused', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-live-'));
    const store = SqliteEventStore.forHome(home);
    await store.append(
      row({ at: '2026-10-02T11:58:00.000Z', target: '/r/src/orders.ts' }),
    );
    await store.append(
      row({
        at: '2026-10-02T11:59:00.000Z',
        surface: 'git',
        operation: 'git.push',
        target: 'main',
        effect: 'deny',
      }),
    );
    store.close();
    await new SessionTasks(home).declare({
      id: 'tsk_1',
      sessionId: 'ses_live',
      statement: 'add order cancellation',
      scope: {},
      declaredAt: '2026-10-02T11:50:00.000Z',
    });
    await new SessionTurns(home).prompted(
      'ses_live',
      'claude-code',
      '2026-10-02T11:57:00.000Z',
    );

    const view = await new SessionViews(home, () => NOW).view('ses_live');
    expect(view).toMatchObject({
      agentName: 'Claude Code',
      task: 'add order cancellation',
      state: 'working',
      thinking: true,
    });
    expect(view?.steps).toEqual([
      expect.objectContaining({ surface: 'filesystem', text: 'Edited src/orders.ts' }),
      expect.objectContaining({ surface: 'git', text: 'Pushed main', refused: true }),
    ]);
    expect(await new SessionViews(home, () => NOW).view('ses_unknown')).toBeNull();
    // The switcher's cards: the same session, with who it is and what it is on.
    expect(await new SessionViews(home, () => NOW).list()).toEqual([
      expect.objectContaining({
        sessionId: 'ses_live',
        agentName: 'Claude Code',
        task: 'add order cancellation',
        thinking: true,
      }),
    ]);
  });
});
