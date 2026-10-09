import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionHosts, SessionTurns, SpokenInstructions } from '@memnox/core';
import { sendInstructionTool } from '../src/session-tools/instruct-tools';
import { paneOn, typeIntoPane, type PaneSeams } from '../src/session-tools/multiplexer';
import { callOperatorTool } from '../src/session-tools/operator-tools';
import type { SessionToolDeps } from '../src/session-tools/read-tools';
import type { RewindSeams } from '../src/session-tools/rewind-tool';

const NOW = new Date('2026-10-09T12:00:00.000Z');

/** A tmux server holding two panes, which records every command it is given. */
function tmuxWith(panes: string, screen = ''): { seams: PaneSeams; ran: string[][] } {
  const ran: string[][] = [];
  const seams: PaneSeams = {
    run: (file, args) => {
      if (file !== 'tmux') return null;
      ran.push([...args]);
      if (args[0] === 'list-panes') return panes;
      if (args[0] === 'capture-pane') return screen;
      return '';
    },
    pause: async () => undefined,
  };
  return { seams, ran };
}

describe('a tmux or WezTerm pane', () => {
  it('is found by the terminal the agent runs on', () => {
    const { seams } = tmuxWith('/dev/ttys004 %1\n/dev/ttys009 %7\n');
    expect(paneOn('ttys009', seams)).toEqual({
      multiplexer: 'tmux',
      id: '%7',
      program: 'tmux',
    });
    expect(paneOn('ttys002', seams)).toBeNull();
  });

  it('is found in WezTerm when no tmux holds it', () => {
    const seams: PaneSeams = {
      run: (file) =>
        file === 'wezterm'
          ? JSON.stringify([{ pane_id: 3, tty_name: '/dev/ttys011' }])
          : null,
      pause: async () => undefined,
    };
    expect(paneOn('ttys011', seams)).toMatchObject({ multiplexer: 'WezTerm', id: '3' });
  });

  it('takes the words, then Return a beat later, and is called landed only when it shows them', async () => {
    const { seams, ran } = tmuxWith('', '> push the voice branch please\n');
    const pane = { multiplexer: 'tmux' as const, id: '%7', program: 'tmux' };
    const typed = await typeIntoPane(pane, 'push the voice branch\nplease', seams);
    expect(ran.slice(0, 2)).toEqual([
      ['send-keys', '-t', '%7', '-l', 'push the voice branch please'],
      ['send-keys', '-t', '%7', 'Enter'],
    ]);
    expect(typed.proof?.seen).toBe('push the voice branch please');
    const unseen = await typeIntoPane(pane, 'push it', tmuxWith('', '$ ').seams);
    expect(unseen).toEqual({ sent: true });
  });
});

/** A process on a terminal of its own, as an agent in a pane is, so its device is read for real. */
let held: ChildProcess | null = null;
async function onATerminal(): Promise<{ pid: number; tty: string }> {
  held = spawn('script', ['-q', '/dev/null', 'sleep', '30'], { stdio: 'ignore' });
  for (let look = 0; look < 40; look += 1) {
    await sleep(50);
    const child = execFileSync('pgrep', ['-P', String(held.pid)], { encoding: 'utf8' })
      .trim()
      .split('\n')[0];
    if (child === undefined || child === '') continue;
    const tty = execFileSync('ps', ['-o', 'tty=', '-p', child], {
      encoding: 'utf8',
    }).trim();
    return { pid: Number(child), tty };
  }
  throw new Error('the process on a terminal never started');
}

afterEach(() => {
  held?.kill();
  held = null;
});

async function inAPane(
  screen: string,
): Promise<{ deps: SessionToolDeps; ran: string[][] }> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-pane-'));
  const { pid, tty } = await onATerminal();
  await new SessionHosts(home).note({
    sessionId: 'ses_pane',
    agent: 'claude-code',
    pid,
    seenAt: NOW.toISOString(),
  });
  const { seams, ran } = tmuxWith(`/dev/${tty} %2\n`, screen);
  const deps: SessionToolDeps = {
    home,
    cwd: home,
    agent: 'claude-code',
    env: {},
    now: () => NOW,
    readStatus: async () => ({}),
    milestonesAt: async () => [],
    brief: async () => null,
    panes: seams,
  };
  return { deps, ran };
}

describe('an agent in a tmux pane', () => {
  it('is typed into through tmux, with no app and no window brought forward', async () => {
    const { deps, ran } = await inAPane('> run the tests\n');
    const instruction = await new SpokenInstructions(deps.home).propose({
      sessionId: 'ses_pane',
      agent: 'claude-code',
      message: 'run the tests',
      at: NOW.toISOString(),
    });
    const answer = await sendInstructionTool(
      deps,
      { instruction: instruction.id },
      () => true,
    );
    expect(answer).toMatchObject({
      sent: true,
      how: 'typed',
      proof: { seen: 'run the tests' },
    });
    expect(ran).toContainEqual(['send-keys', '-t', '%2', '-l', 'run the tests']);
  });

  it('is stopped with Escape through tmux', async () => {
    const { deps, ran } = await inAPane('');
    await new SessionTurns(deps.home).prompted(
      'ses_pane',
      'claude-code',
      NOW.toISOString(),
    );
    expect(
      await callOperatorTool(deps, {} as RewindSeams, 'show', {
        session: 'ses_pane',
        display: 'stop',
      }),
    ).toMatchObject({ stopped: true });
    expect(ran).toContainEqual(['send-keys', '-t', '%2', 'Escape']);
  });
});
