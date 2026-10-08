import { describe, expect, it } from 'vitest';
import type { HermesSession } from '@memnox/core';
import { hermesCards, isHermesSession } from '../src/daemon/hermes-view';

const NOW = new Date('2026-10-06T12:00:00.000Z');

const session = (over: Partial<HermesSession>): HermesSession => ({
  id: 's_1',
  startedAt: '2026-10-06T11:00:00.000Z',
  lastActive: '2026-10-06T11:59:30.000Z',
  toolCalls: 3,
  ...over,
});

describe('Hermes sessions on the switcher', () => {
  it('shows an open session as a card named the way the person named Hermes', () => {
    const cards = hermesCards('/home/deploy', NOW, 'Ops bot', () => [
      session({ title: 'Rotate the logs', directory: '/srv/billing' }),
      session({ id: 's_2', lastActive: '2026-10-06T09:00:00.000Z' }),
      session({ id: 's_done', endedAt: '2026-10-06T10:00:00.000Z' }),
    ]);

    expect(cards.map((card) => card.sessionId)).toEqual(['hermes:s_1', 'hermes:s_2']);
    expect(cards[0]).toMatchObject({
      agent: 'hermes',
      agentName: 'Ops bot',
      task: 'Rotate the logs',
      repository: 'billing',
      state: 'working',
      thinking: true,
      actions: 3,
    });
    expect(cards[1]).toMatchObject({ state: 'open', thinking: false });
    expect(isHermesSession(cards[0]?.sessionId ?? '')).toBe(true);
    expect(isHermesSession('ses_ledger')).toBe(false);
  });
});
