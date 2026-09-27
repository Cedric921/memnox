import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTOR_TYPE,
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  TOOL_CLASS,
  type Account,
  type EventQuery,
  type EventSink,
  type MemnoxEvent,
} from '@memnox/core';
import { pushEvents, PUSH_OUTCOME } from '../src/sync/push';

const event = (id: string, at: string): MemnoxEvent => ({
  id,
  schemaVersion: EVENT_SCHEMA_VERSION,
  at,
  sessionId: 'ses_1',
  agent: 'claude-code',
  actorType: ACTOR_TYPE.AGENT,
  surface: EVENT_SURFACE.SHELL,
  operation: 'git.status',
  class: TOOL_CLASS.READ,
  effect: DECISION_EFFECT.ALLOW,
  mode: ENFORCEMENT_MODE.ENFORCE,
  reason: 'reading is allowed',
  argsDigest: 'abc123',
});

/** Chronological from `since`, as the ledger answers. */
function ledgerOf(events: MemnoxEvent[]): EventSink {
  return {
    append: async (each) => {
      events.push(each);
    },
    query: async (filter: EventQuery) =>
      events
        .filter((each) => filter.since === undefined || each.at >= filter.since)
        .sort((a, b) => a.at.localeCompare(b.at))
        .slice(0, filter.limit),
  };
}

/* Every pass read the last minute back and posted all of it, so an active machine
   sent each event twenty or thirty times and posted on every pass even when nothing
   was new. The minute is still read, and what already landed is left out. */
describe('what a push sends from the minute it reads back', () => {
  let home: string;
  let posted: string[][];

  const account = (): Account => ({
    version: 1,
    baseUrl: 'https://cloud.test',
    workspaceId: 'acme',
    machineId: 'mch_1',
    token: ['mch', 'test', 'value'].join('_'),
    privateKey: generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    enrolledAt: '2026-09-27T11:00:00.000Z',
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-overlap-'));
    posted = [];
    vi.stubGlobal('fetch', async (_url: URL, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        events: { kind: string; dedupKey: string }[];
      };
      // The session row a batch opens with is keyed `session:`, and is not an action.
      const actions = body.events.filter((each) => !each.dedupKey.startsWith('session:'));
      posted.push(actions.map((each) => each.dedupKey));
      return new Response(JSON.stringify({ accepted: actions.length, duplicates: 0 }), {
        status: 202,
      });
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  });

  it('posts nothing on a pass where nothing new was recorded', async () => {
    const me = account();
    const ledger = ledgerOf([
      event('e1', '2026-09-27T12:00:00.000Z'),
      event('e2', '2026-09-27T12:00:10.000Z'),
    ]);

    expect((await pushEvents(home, me, ledger)).outcome).toBe(PUSH_OUTCOME.SENT);
    expect((await pushEvents(home, me, ledger)).outcome).toBe(PUSH_OUTCOME.NOTHING);

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual(expect.arrayContaining(['e1', 'e2']));
  });

  /* Why the minute is read back at all: a hook in another process writes an event
     stamped before the cursor, after the cursor has passed it. */
  it('still sends an event another process stamped behind the cursor, and only that', async () => {
    const me = account();
    const recorded = [
      event('e1', '2026-09-27T12:00:00.000Z'),
      event('e2', '2026-09-27T12:00:10.000Z'),
    ];
    const ledger = ledgerOf(recorded);
    await pushEvents(home, me, ledger);

    await ledger.append(event('late', '2026-09-27T12:00:05.000Z'));
    await pushEvents(home, me, ledger);

    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual(['late']);
  });
});
