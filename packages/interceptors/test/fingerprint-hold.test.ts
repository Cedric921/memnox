import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ACTION, DECISION_EFFECT, ENFORCEMENT_MODE, TOOL_CLASS } from '@memnox/core';

import { EDIT_HOST } from '../src/agent-edits';
import type { EditHookContext } from '../src/edit-claims';
import { fingerprintHold, RECORD_FIRST } from '../src/fingerprint-hold';
import type { ToolAnswer } from '../src/tool-hook';

/* The ask at session start alone was skipped by an agent busy with its task, so a repository
   that states no fingerprint has the first write of a session held once, and only once. */

const NOW = new Date('2026-09-28T10:00:00.000Z');

async function place(): Promise<{
  home: string;
  repo: string;
  context: EditHookContext;
}> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-fingerprint-hold-'));
  const repo = join(home, 'work', 'repo');
  await mkdir(repo, { recursive: true });
  const context = {
    home,
    agent: 'claude-code',
    runSession: undefined,
    pid: 1,
    cwd: repo,
    now: () => NOW,
  };
  return { home, repo, context };
}

function write(
  target: string,
  overrides: { sessionId?: string; effect?: string; host?: string } = {},
): ToolAnswer {
  return {
    call: {
      host: (overrides.host ?? EDIT_HOST.PRE_TOOL_USE) as ToolAnswer['call']['host'],
      tool: 'Write',
      sessionId: overrides.sessionId ?? 's1',
      requests: [{ action: ACTION.FILESYSTEM_WRITE, target, class: TOOL_CLASS.WRITE }],
      nativeAsk: true,
    },
    ruling: {
      action: ACTION.FILESYSTEM_WRITE,
      target,
      class: TOOL_CLASS.WRITE,
      effect: (overrides.effect ??
        DECISION_EFFECT.ALLOW) as ToolAnswer['ruling']['effect'],
      mode: ENFORCEMENT_MODE.ENFORCE,
      reason: 'no rule covers it',
    },
    reply: null,
    asked: false,
  };
}

const reasonOf = (reply: string | null): string | undefined =>
  reply === null
    ? undefined
    : (JSON.parse(reply) as { hookSpecificOutput: { permissionDecisionReason: string } })
        .hookSpecificOutput.permissionDecisionReason;

describe('the first write in a repository with no fingerprint', () => {
  it('is held once a session, sending the agent to record one', async () => {
    const { repo, context } = await place();
    const rootOf = (): string => repo;

    const first = await fingerprintHold(write(`${repo}/src/a.ts`), context, rootOf);
    const again = await fingerprintHold(write(`${repo}/src/a.ts`), context, rootOf);
    const elsewhere = await fingerprintHold(
      write(`${repo}/src/a.ts`, { sessionId: 's2' }),
      context,
      rootOf,
    );

    expect(reasonOf(first)).toBe(RECORD_FIRST);
    expect(again).toBeNull();
    expect(reasonOf(elsewhere)).toBe(RECORD_FIRST);
  });

  it('goes ahead where the repository states one', async () => {
    const { repo, context } = await place();
    await mkdir(join(repo, '.memnox'), { recursive: true });
    await writeFile(
      join(repo, '.memnox', 'code-fingerprint.yaml'),
      'naming:\n  files: kebab-case\n',
    );

    expect(
      await fingerprintHold(write(`${repo}/src/a.ts`), context, () => repo),
    ).toBeNull();
  });

  it('holds nothing it was not going to allow, outside the repository, or without a session', async () => {
    const { repo, context } = await place();
    const rootOf = (): string => repo;

    for (const answer of [
      write(`${repo}/src/a.ts`, { effect: DECISION_EFFECT.DENY }),
      write(`${repo}/src/a.ts`, { host: EDIT_HOST.CURSOR }),
      write('/tmp/elsewhere/a.ts'),
      write(`${repo}/src/a.ts`, { sessionId: '' }),
    ]) {
      expect(await fingerprintHold(answer, context, rootOf)).toBeNull();
    }
    expect(
      await fingerprintHold(write(`${repo}/src/a.ts`), context, () => null),
    ).toBeNull();
  });
});
