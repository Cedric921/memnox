import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DisplayRequests } from '@memnox/core';
import { installedAppNamed } from '../src/session-tools/app-tools';
import { callOperatorTool } from '../src/session-tools/operator-tools';
import type { SessionToolDeps } from '../src/session-tools/read-tools';
import type { RewindSeams } from '../src/session-tools/rewind-tool';

const NOW = new Date('2026-10-09T12:00:00.000Z');

describe('typing into any app the person names', () => {
  it('finds it by the name they said, spaces and case aside', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'memnox-apps-'));
    for (const app of [
      'Windsurf.app',
      'Visual Studio Code.app',
      'Zed Preview.app',
      'iTerm.app',
    ]) {
      await mkdir(join(folder, app));
    }
    expect(installedAppNamed('windsurf', [folder])).toBe(join(folder, 'Windsurf.app'));
    expect(installedAppNamed('visual studio code', [folder])).toBe(
      join(folder, 'Visual Studio Code.app'),
    );
    expect(installedAppNamed('Zed', [folder])).toBe(join(folder, 'Zed Preview.app'));
    expect(installedAppNamed('iTerm2', [folder])).toBe(join(folder, 'iTerm.app'));
    expect(installedAppNamed('Perplexity', [folder])).toBeNull();
  });

  it('hands the Mac the app and the words, and says so when the app is not there', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-any-app-'));
    const deps: SessionToolDeps = {
      home,
      cwd: home,
      agent: 'claude-code',
      env: {},
      now: () => NOW,
      readStatus: async () => ({}),
      milestonesAt: async () => [],
      brief: async () => null,
      findApp: (name) => (name === 'Windsurf' ? '/Applications/Windsurf.app' : null),
      delivered: async () => ({ outcome: 'typed', at: NOW.toISOString() }),
    };
    const seams = {} as RewindSeams;
    expect(
      await callOperatorTool(deps, seams, 'type_in_app', {
        app: 'Windsurf',
        message: 'ask Cascade to fix the build',
      }),
    ).toMatchObject({ app: 'Windsurf', typed: true });
    const [request] = await new DisplayRequests(home).open(NOW.toISOString());
    expect(request).toMatchObject({
      display: 'app',
      appPath: '/Applications/Windsurf.app',
      text: 'ask Cascade to fix the build',
    });
    const missing = (await callOperatorTool(deps, seams, 'type_in_app', {
      app: 'Perplexity',
      message: 'hello',
    })) as { typed: boolean; said: string };
    expect(missing.typed).toBe(false);
    expect(missing.said).toContain('No app called Perplexity');
  });
});
