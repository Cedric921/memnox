import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunTerminals } from '@memnox/core';
import type { SessionToolDeps } from '../src/session-tools/read-tools';
import { sessionsTool } from '../src/session-tools/sessions-tool';

const NOW = new Date('2026-10-15T05:50:00.000Z');
/** A pid nothing on this machine can hold, so its run reads as over. */
const GONE_PID = 2 ** 22 + 7;

async function depsAt(): Promise<SessionToolDeps> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-launched-'));
  return {
    home,
    cwd: home,
    agent: 'unknown-agent',
    env: {},
    now: () => NOW,
    readStatus: async () => ({ mode: 'enforce' }),
    milestonesAt: async () => [],
    brief: async () => null,
  };
}

type Row = {
  session: string;
  agent: string;
  repositories: string[];
  started: string;
  runningIn?: string;
};

describe('a session memnox run launched a moment ago', () => {
  it('is counted before its agent fires a hook, under the agent and folder the run noted', async () => {
    const deps = await depsAt();
    await new RunTerminals(deps.home).note({
      sessionId: 'ses_fresh',
      agent: 'claude-code',
      pid: process.pid,
      app: 'Terminal',
      cwd: '/Users/ana/code/shop',
      startedAt: '2026-10-15T05:49:00.000Z',
    });
    const rows = (await sessionsTool(deps, {})) as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session: 'ses_fresh',
      agent: 'claude-code',
      repositories: ['/Users/ana/code/shop'],
      started: '2026-10-15T05:49:00.000Z',
      runningIn: 'Terminal',
    });
  });

  it('is left out once its run has ended', async () => {
    const deps = await depsAt();
    await new RunTerminals(deps.home).note({
      sessionId: 'ses_over',
      agent: 'claude-code',
      pid: GONE_PID,
      cwd: '/Users/ana/code/shop',
      startedAt: '2026-10-15T05:49:00.000Z',
    });
    expect(await sessionsTool(deps, {})).toEqual([]);
  });
});
