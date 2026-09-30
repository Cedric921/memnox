import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentProcessOf,
  hostOf,
  SessionHosts,
  type HostProcess,
} from '../src/discovery/session-host';

const VSCODE: HostProcess[] = [
  { pid: 40, command: '/bin/zsh', tty: '??' },
  { pid: 30, command: '/Users/me/.local/bin/claude', tty: 'ttys007' },
  { pid: 20, command: '/bin/zsh', tty: 'ttys007' },
  {
    pid: 10,
    command:
      '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
    tty: '??',
  },
];

describe('where a session runs', () => {
  it('names the outermost app, since an editor runs its terminal inside a helper of its own', () => {
    expect(hostOf(VSCODE)).toEqual({
      tty: 'ttys007',
      appPath: '/Applications/Visual Studio Code.app',
      app: 'Visual Studio Code',
    });
  });

  it('finds iTerm and its tab', () => {
    expect(
      hostOf([
        { pid: 3, command: 'claude', tty: 'ttys004' },
        { pid: 2, command: '-zsh', tty: 'ttys004' },
        { pid: 1, command: '/Applications/iTerm.app/Contents/MacOS/iTerm2', tty: '??' },
      ]),
    ).toEqual({ tty: 'ttys004', appPath: '/Applications/iTerm.app', app: 'iTerm' });
  });

  it('says nothing it does not know, rather than guessing an app', () => {
    expect(hostOf([{ pid: 1, command: '/usr/sbin/sshd', tty: '??' }])).toEqual({});
  });

  it('takes the agent to be the first process above the hook that is not a shell', () => {
    expect(agentProcessOf(VSCODE)?.pid).toBe(30);
  });

  it('notes a session once, and keeps the first answer', async () => {
    const hosts = new SessionHosts(await mkdtemp(join(tmpdir(), 'memnox-hosts-')));
    const first = {
      sessionId: 'a/b:c',
      agent: 'claude-code',
      pid: 30,
      seenAt: 't1',
      app: 'iTerm',
    };
    await hosts.note(first);
    await hosts.note({ ...first, app: 'Terminal', seenAt: 't2' });
    expect(await hosts.read('a/b:c')).toEqual(first);
  });
});
