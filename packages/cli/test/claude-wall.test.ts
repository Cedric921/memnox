import { describe, expect, it } from 'vitest';
import {
  WALLED_OFF,
  wallSupported,
  withKernelWall,
  withoutKernelWall,
} from '../src/protect/claude-wall';

/* A check on the command line can be talked around by code that builds the path at run
   time, so the agent's shell is walled off from Memnox's state and the hook settings. */
describe('the wall around the agent’s shell', () => {
  it('turns the sandbox on, shuts the unsandboxed door, and walls off what governs the agent', () => {
    const walled = withKernelWall({ hooks: {} }) as {
      sandbox: {
        enabled: boolean;
        allowUnsandboxedCommands: boolean;
        filesystem: { allowWrite: string[]; denyWrite: string[] };
        network: { allowedDomains: string[] };
      };
    };
    expect(walled.sandbox.enabled).toBe(true);
    expect(walled.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(walled.sandbox.filesystem.denyWrite).toEqual([...WALLED_OFF]);
    // Everything else stays as open as an unsandboxed shell had it, so ordinary work goes on.
    expect(walled.sandbox.filesystem.allowWrite).toEqual(['~/']);
    expect(walled.sandbox.network.allowedDomains).toEqual(['*']);
  });

  it('keeps what the person already set, and adds only the wall', () => {
    const own = {
      sandbox: {
        enabled: false,
        filesystem: { denyWrite: ['~/secrets/'], allowWrite: ['~/work/'] },
        network: { allowedDomains: ['github.com'] },
      },
    };
    const walled = withKernelWall(own) as typeof own & {
      sandbox: { filesystem: { denyWrite: string[] } };
    };
    expect(walled.sandbox.filesystem.denyWrite).toEqual(['~/secrets/', ...WALLED_OFF]);
    expect(walled.sandbox.filesystem.allowWrite).toEqual(['~/work/']);
    expect(walled.sandbox.network.allowedDomains).toEqual(['github.com']);
  });

  it('puts the person’s own sandbox back, and never takes down one it did not put up', () => {
    const before = { enabled: false };
    const walled = withKernelWall({ sandbox: before, theme: 'dark' });
    expect(withoutKernelWall(walled, before)).toEqual({ sandbox: before, theme: 'dark' });
    expect(withoutKernelWall(withKernelWall({ theme: 'dark' }), null)).toEqual({
      theme: 'dark',
    });

    const theirs = { sandbox: { enabled: true, filesystem: { denyWrite: ['~/x/'] } } };
    expect(withoutKernelWall(theirs, null)).toBe(theirs);
  });

  it.each([
    ['2.1.283 (Claude Code)', true],
    ['2.1.186 (Claude Code)', true],
    ['2.1.185 (Claude Code)', false],
    ['1.9.999', false],
    [null, false],
  ])('holds the wall on %s: %s', (version, held) => {
    expect(wallSupported(version)).toBe(held);
  });
});
