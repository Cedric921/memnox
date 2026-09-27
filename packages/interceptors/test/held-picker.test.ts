import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FileGrants,
  grantSubjectFor,
  holdInChat,
  PendingApprovals,
  type ChatQuestion,
  type PendingApproval,
} from '@memnox/core';
import { answerPicker, type PickerContext } from '../src/held-picker';

const NOW = new Date('2026-09-27T04:30:00.000Z');

const DELETE: ChatQuestion = {
  sessionId: 's1',
  agent: 'claude-code',
  action: 'filesystem.delete',
  target: 'finish-cloud.patch',
  class: 'destructive',
  reason: 'you chose to be asked about this',
};

function context(home: string): PickerContext {
  return { home, runSession: undefined, now: () => NOW, person: () => 'moise' };
}

async function held(): Promise<{ home: string; held: PendingApproval }> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-picker-'));
  const raised = await holdInChat(
    new PendingApprovals(home),
    DELETE,
    'session',
    NOW.toISOString(),
  );
  return { home, held: raised };
}

/** The payloads Claude Code sends, in the shape a probe recorded them in. */
function picker(
  event: 'PreToolUse' | 'PostToolUse',
  id: string,
  answers?: Record<string, string>,
): unknown {
  const question = `Claude Code wants to delete finish-cloud.patch. Allow it? (${id})`;
  const questions = [
    {
      question,
      header: 'Memnox',
      options: [
        { label: 'Allow once' },
        { label: 'Allow for this session' },
        { label: 'Deny' },
      ],
      multiSelect: false,
    },
  ];
  const input = answers === undefined ? { questions } : { questions, answers };
  return {
    session_id: 's1',
    hook_event_name: event,
    tool_name: 'AskUserQuestion',
    tool_use_id: 'toolu_01',
    tool_input: input,
    ...(event === 'PostToolUse' ? { tool_response: input } : {}),
  };
}

function question(id: string): string {
  return `Claude Code wants to delete finish-cloud.patch. Allow it? (${id})`;
}

describe('a held question answered in Claude Code’s own picker', () => {
  it('takes the person’s pick from a picker it saw open empty', async () => {
    const { home, held: raised } = await held();
    expect(await answerPicker(picker('PreToolUse', raised.id), context(home))).toEqual(
      {},
    );
    const after = await answerPicker(
      picker('PostToolUse', raised.id, {
        [question(raised.id)]: 'Allow for this session',
      }),
      context(home),
    );

    expect(after?.stdout).toContain('said yes for the rest of this session');
    expect(await new FileGrants(home).covers(grantSubjectFor(DELETE))).toBe(true);
  });

  it('refuses a picker the agent sent with its own answer filled in', async () => {
    const { home, held: raised } = await held();
    const answers = { [question(raised.id)]: 'Allow once' };
    const before = await answerPicker(
      picker('PreToolUse', raised.id, answers),
      context(home),
    );
    expect(before?.stdout).toContain('"permissionDecision":"deny"');

    // Even if the host ran it anyway, an answer from a picker never seen empty counts for nothing.
    expect(
      await answerPicker(picker('PostToolUse', raised.id, answers), context(home)),
    ).toEqual({});
    const still = await new PendingApprovals(home).read(raised.id);
    expect(still?.answer).toBeUndefined();
  });

  it('ignores an answer from a picker it never saw open', async () => {
    const { home, held: raised } = await held();
    const answers = { [question(raised.id)]: 'Allow once' };
    await answerPicker(picker('PostToolUse', raised.id, answers), context(home));
    expect((await new PendingApprovals(home).read(raised.id))?.answer).toBeUndefined();
  });

  it('reads Deny as a no', async () => {
    const { home, held: raised } = await held();
    await answerPicker(picker('PreToolUse', raised.id), context(home));
    const after = await answerPicker(
      picker('PostToolUse', raised.id, { [question(raised.id)]: 'Deny' }),
      context(home),
    );
    expect(after?.stdout).toContain('said no: do not delete finish-cloud.patch');
  });

  it('leaves every other picker to the agent', async () => {
    const { home } = await held();
    expect(
      await answerPicker(picker('PreToolUse', 'apr_nothere_1'), context(home)),
    ).toBeNull();
  });

  it('refuses to open a picker for a question already answered in the DM, and says who answered', async () => {
    const { home, held: raised } = await held();
    await new PendingApprovals(home).answer(
      raised.id,
      'session',
      'Moise in Discord',
      NOW.toISOString(),
    );

    const before = await answerPicker(picker('PreToolUse', raised.id), context(home));
    const said = JSON.parse(before?.stdout ?? '{}') as {
      hookSpecificOutput: {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
      systemMessage: string;
    };
    expect(said.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(said.hookSpecificOutput.permissionDecisionReason).toContain(
      'said yes for the rest of this session',
    );
    expect(said.systemMessage).toContain('Moise in Discord already answered this');
  });

  it('keeps the DM answer when it lands while the picker is open, and says the pick was not used', async () => {
    const { home, held: raised } = await held();
    await answerPicker(picker('PreToolUse', raised.id), context(home));
    await new PendingApprovals(home).answer(
      raised.id,
      'session',
      'Moise in Discord',
      NOW.toISOString(),
    );

    const after = await answerPicker(
      picker('PostToolUse', raised.id, { [question(raised.id)]: 'Allow once' }),
      context(home),
    );
    expect(after?.stdout).toContain('said yes for the rest of this session');
    expect(after?.stdout).toContain('is not used');
    expect((await new PendingApprovals(home).read(raised.id))?.answer).toBe('session');
  });
});
