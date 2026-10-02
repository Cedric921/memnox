import { describe, expect, it } from 'vitest';
import {
  isTestCommand,
  shellQuoted,
  startCommand,
  watchFired,
  WATCH_FOR,
  type SessionWatch,
  type WatchFacts,
} from '../src/index';

const SET_AT = '2026-10-02T12:00:00.000Z';

function watch(forWhat: SessionWatch['for']): SessionWatch {
  return {
    id: 'wch_1',
    sessionId: 'ses_1',
    agent: 'claude-code',
    for: forWhat,
    setAt: SET_AT,
    expiresAt: '2026-10-02T16:00:00.000Z',
  };
}

const QUIET: WatchFacts = { testRuns: [], paused: false, held: 0 };

describe('a watch the person asked for', () => {
  it('fires on a turn that ended after it was set, never one that ended before', () => {
    expect(
      watchFired(watch(WATCH_FOR.FINISHED), {
        ...QUIET,
        endedAt: '2026-10-02T11:59:00.000Z',
      }),
    ).toBeNull();
    expect(
      watchFired(watch(WATCH_FOR.FINISHED), {
        ...QUIET,
        promptAt: '2026-10-02T12:05:00.000Z',
        endedAt: '2026-10-02T12:01:00.000Z',
      }),
    ).toBeNull();
    expect(
      watchFired(watch(WATCH_FOR.FINISHED), {
        ...QUIET,
        endedAt: '2026-10-02T12:01:00.000Z',
      }),
    ).toMatchObject({ what: 'it finished its turn' });
  });

  it('tells passing from failing runs, and ignores runs from before it was set', () => {
    const facts: WatchFacts = {
      ...QUIET,
      testRuns: [
        { at: '2026-10-02T11:50:00.000Z', command: 'pnpm test', passed: true },
        { at: '2026-10-02T12:02:00.000Z', command: 'pnpm test', passed: false },
      ],
    };
    expect(watchFired(watch(WATCH_FOR.TESTS_PASS), facts)).toBeNull();
    expect(watchFired(watch(WATCH_FOR.TESTS_FAIL), facts)).toMatchObject({
      what: 'pnpm test failed',
    });
  });

  it('calls a paused session or one waiting on the person stuck', () => {
    expect(watchFired(watch(WATCH_FOR.STUCK), QUIET)).toBeNull();
    expect(watchFired(watch(WATCH_FOR.STUCK), { ...QUIET, held: 1 })).not.toBeNull();
    expect(watchFired(watch(WATCH_FOR.STUCK), { ...QUIET, paused: true })).toMatchObject({
      what: 'it is paused',
    });
  });

  it('knows a test run from any other command', () => {
    for (const command of [
      'pnpm test',
      'npm run test',
      'npx vitest run',
      'cd app && swift test',
      'pytest -q',
      'go test ./...',
    ]) {
      expect(isTestCommand(command)).toBe(true);
    }
    for (const command of ['git status', 'cat test.ts', 'pnpm build', 'latest']) {
      expect(isTestCommand(command)).toBe(false);
    }
  });
});

describe('the line that starts a session', () => {
  it('quotes the task whole, so nothing in it runs', () => {
    expect(shellQuoted(`it's $(rm -rf ~); done`)).toBe(`'it'\\''s $(rm -rf ~); done'`);
    expect(
      startCommand({
        id: 'stt_1',
        agent: 'codex',
        command: 'codex',
        repository: '/r',
        task: 'add a test\nthen push',
        proposedAt: SET_AT,
        expiresAt: SET_AT,
      }),
    ).toBe(`cd '/r' && memnox run -- codex 'add a test then push'`);
  });
});
