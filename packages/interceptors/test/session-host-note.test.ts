import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionHosts } from '@memnox/core';
import { noteSessionHost, processChain } from '../src/session-host-note';

const LISTING = [
  '  500   400 ttys007  /Users/me/.local/bin/claude',
  '  400   300 ttys007  -zsh',
  '  300     1 ??       /Applications/Visual Studio Code.app/Contents/MacOS/Electron',
  '  999     1 ??       /usr/sbin/unrelated',
].join('\n');

describe('noting where a session runs', () => {
  it('walks up from a process, keeping paths with spaces whole', () => {
    expect(processChain(500, () => LISTING)).toEqual([
      { pid: 500, command: '/Users/me/.local/bin/claude', tty: 'ttys007' },
      { pid: 400, command: '-zsh', tty: 'ttys007' },
      {
        pid: 300,
        command: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
        tty: '??',
      },
    ]);
  });

  it('writes it down at a session start, under the id the ledger uses', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-host-note-'));
    await noteSessionHost(
      { hook_event_name: 'SessionStart', session_id: 'abc-123', cwd: '/work/shop' },
      {
        home,
        agent: 'claude-code',
        runSession: undefined,
        pid: process.pid,
        cwd: '/elsewhere',
        now: () => new Date('2026-09-30T12:00:00.000Z'),
      },
      () =>
        [
          `  ${process.ppid}   400 ttys009  /bin/zsh`,
          '  400   300 ttys009  /Users/me/.local/bin/claude',
          '  300     1 ??       /Applications/Ghostty.app/Contents/MacOS/ghostty',
        ].join('\n'),
    );
    const host = await new SessionHosts(home).read('abc-123');
    expect(host).toMatchObject({
      sessionId: 'abc-123',
      agent: 'claude-code',
      cwd: '/work/shop',
      seenAt: '2026-09-30T12:00:00.000Z',
      pid: 400,
      app: 'Ghostty',
      tty: 'ttys009',
    });
  });

  it('still notes the session where ps cannot run, just without its app', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-host-note-'));
    await noteSessionHost(
      { hook_event_name: 'SessionStart', session_id: 'no-ps' },
      {
        home,
        agent: 'a',
        runSession: 'ses_run',
        pid: 1,
        cwd: '/w',
        now: () => new Date(),
      },
      () => {
        throw new Error('spawnSync ps EPERM');
      },
    );
    const host = await new SessionHosts(home).read('ses_run');
    expect(host).toMatchObject({ sessionId: 'ses_run', cwd: '/w' });
    expect(host?.app).toBeUndefined();
  });

  it('keeps the agent its own id under memnox run, and follows it to a cleared conversation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-host-note-'));
    const context = {
      home,
      agent: 'claude-code',
      runSession: 'ses_1eb61120-4c7',
      pid: 1,
      cwd: '/w',
      now: () => new Date('2026-10-02T08:17:02.000Z'),
    };
    const noPs = (): string => '';
    await noteSessionHost(
      { hook_event_name: 'SessionStart', session_id: '9ddff478-4759' },
      context,
      noPs,
    );
    expect(await new SessionHosts(home).read('ses_1eb61120-4c7')).toMatchObject({
      agentSession: '9ddff478-4759',
    });
    await noteSessionHost(
      { hook_event_name: 'SessionStart', session_id: 'aa11bb22-cc33' },
      context,
      noPs,
    );
    expect(await new SessionHosts(home).read('ses_1eb61120-4c7')).toMatchObject({
      agentSession: 'aa11bb22-cc33',
      seenAt: '2026-10-02T08:17:02.000Z',
    });
  });

  it('ignores anything that is not a session start', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-host-note-'));
    await noteSessionHost(
      { hook_event_name: 'PreToolUse', session_id: 'abc-123' },
      {
        home,
        agent: 'a',
        runSession: undefined,
        pid: 1,
        cwd: '/',
        now: () => new Date(),
      },
    );
    expect(await new SessionHosts(home).read('abc-123')).toBeNull();
  });
});
