import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SessionHosts,
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
        agent: 'claude-code',
        agentName: 'Claude Code',
        task: 'add order cancellation',
        thinking: true,
      }),
    ]);
  });

  it('shows the lines it changed in the file it changed most', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-live-'));
    const repo = realpathSync(await mkdtemp(join(tmpdir(), 'memnox-live-repo-')));
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        cwd: repo,
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_COMMITTER_DATE: '2026-10-02T11:00:00Z',
          GIT_AUTHOR_DATE: '2026-10-02T11:00:00Z',
        },
      });
    };
    git('init', '-q');
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, 'src', 'invoice.ts'), 'export const TVA = 0.2;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'start');
    await writeFile(
      join(repo, 'src', 'invoice.ts'),
      'export const TVA = 0.196;\nexport const total = 0;\n',
    );
    const touched = new Date('2026-10-02T11:58:30.000Z');
    await utimes(join(repo, 'src', 'invoice.ts'), touched, touched);
    await new SessionHosts(home).note({
      sessionId: 'ses_live',
      agent: 'claude-code',
      pid: process.pid,
      seenAt: '2026-10-02T11:50:00.000Z',
      cwd: repo,
    });
    const store = SqliteEventStore.forHome(home);
    await store.append(row({ target: 'src/invoice.ts' }));
    store.close();
    const turns = new SessionTurns(home);
    await turns.prompted('ses_live', 'claude-code', '2026-10-02T11:55:00.000Z');
    await turns.ended('ses_live', 'claude-code', '2026-10-02T11:59:30.000Z');

    const view = await new SessionViews(home, () => NOW).view('ses_live');
    expect(view?.excerpt).toEqual({
      path: 'src/invoice.ts',
      lines: [
        '-export const TVA = 0.2;',
        '+export const TVA = 0.196;',
        '+export const total = 0;',
      ],
    });
  });
});
