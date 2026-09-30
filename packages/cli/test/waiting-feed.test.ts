import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PendingApprovals,
  SessionHosts,
  SessionTasks,
  writeJsonFile,
  type HoldRequest,
} from '@memnox/core';
import { WaitingFeed } from '../src/daemon/waiting-feed';

const NOW = '2026-09-30T12:00:00.000Z';

const HELD: HoldRequest = {
  sessionId: 'ses_shop',
  agent: 'claude-code',
  operation: 'git.push',
  target: 'main',
  fingerprint: 'abc123def456',
  reason: 'pushing to main needs a person',
};

describe('a held call, as a person needs to hear it', () => {
  it('carries who, where, doing what, and why, rather than one finished line', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-feed-'));
    await new PendingApprovals(home).raise(HELD, NOW, 120_000);
    await new SessionTasks(home).declare({
      id: 'tsk_1',
      sessionId: 'ses_shop',
      statement: 'add order cancellation',
      scope: {},
      declaredAt: NOW,
    });
    await new SessionHosts(home).note({
      sessionId: 'ses_shop',
      agent: 'claude-code',
      pid: 1,
      cwd: '/Users/me/work/shop',
      seenAt: NOW,
    });
    await writeJsonFile(join(home, '.memnox', 'agents', 'names.json'), {
      'agt_claude-code': 'Claude',
    });

    const [event] = await new WaitingFeed(home).current(NOW);
    expect(event).toMatchObject({
      kind: 'held',
      agent: 'claude-code',
      agentName: 'Claude',
      why: 'Pushing to main needs a person.',
      task: 'add order cancellation',
      place: 'shop',
    });
    expect(event?.what).toBe('push main');
  });

  it('leaves out what it does not know, and names the agent by its product', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-feed-'));
    await new PendingApprovals(home).raise(HELD, NOW, 120_000);
    const [event] = await new WaitingFeed(home).current(NOW);
    expect(event?.agentName).toBe('Claude Code');
    expect(event?.task).toBeUndefined();
    expect(event?.place).toBeUndefined();
  });
});
