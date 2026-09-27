import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  answeredText,
  grantSubjectFor,
  heldNotice,
  holdInChat,
  openQuestionFor,
  replyOf,
  type ChatQuestion,
} from '../src/gate/chat-approval';
import { PendingApprovals, type PendingApproval } from '../src/gate/pending';
import { FileGrants } from '../src/gate/session-grants';

function held(id: string): PendingApproval {
  return {
    id,
    request: {
      sessionId: 's1',
      agent: 'claude-code',
      operation: 'gh.pr-merge',
      fingerprint: id,
      reason: 'r',
    },
    askedAt: '2026-09-26T10:00:00.000Z',
    expiresAt: '2026-09-26T10:30:00.000Z',
  };
}

const ONE = [held('apr_a1_b2')];
const TWO = [held('apr_a1_b2'), held('apr_c3_d4')];

describe('reading a reply as an answer', () => {
  it.each([
    ['1', 'once'],
    ['2.', 'session'],
    ['3', 'deny'],
    ['yes', 'once'],
    ['Allow', 'once'],
    ['go ahead', 'once'],
    ['allow for this session', 'session'],
    ['yes, always', 'session'],
    ['no', 'deny'],
    ["don't", 'deny'],
  ])('reads "%s" as %s when one question waits', (prompt, answer) => {
    expect(replyOf(prompt, ONE)).toEqual({ id: 'apr_a1_b2', answer });
  });

  it('answers nothing with a bare yes while two questions wait', () => {
    expect(replyOf('yes', TWO)).toBeNull();
  });

  it('answers the one a reply names by id', () => {
    expect(replyOf('allow apr_c3_d4', TWO)).toEqual({ id: 'apr_c3_d4', answer: 'once' });
    expect(replyOf('deny apr_zz_zz', TWO)).toBeNull();
  });

  it('reads an instruction as an instruction, however it starts', () => {
    expect(replyOf('now write the tests for the billing module please', ONE)).toBeNull();
    expect(replyOf('no '.repeat(40), ONE)).toBeNull();
    expect(replyOf('yes', [])).toBeNull();
  });
});

describe('an answer given for the rest of the session', () => {
  const MOMENT = '2026-09-27T03:36:49.000Z';

  function question(target: string, cls = 'destructive'): ChatQuestion {
    return {
      sessionId: 's1',
      agent: 'claude-code',
      action: 'filesystem.delete',
      target,
      class: cls,
      reason: 'r',
    };
  }

  async function home(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'memnox-chat-'));
  }

  it('is granted when it is answered, so a DM answer counts without the agent retrying in time', async () => {
    const dir = await home();
    const approvals = new PendingApprovals(dir);
    const held = await holdInChat(approvals, question('a.patch'), 'both', MOMENT);
    await approvals.answer(held.id, 'session', 'Moise', MOMENT);
    const grants = new FileGrants(dir);
    expect(await grants.covers(grantSubjectFor(question('a.patch')))).toBe(true);
  });

  it('covers only the file a delete named, and never answers a question about another', async () => {
    const dir = await home();
    const approvals = new PendingApprovals(dir);
    const held = await holdInChat(approvals, question('a.patch'), 'both', MOMENT);
    await approvals.answer(held.id, 'session', 'Moise', MOMENT);
    expect(await new FileGrants(dir).covers(grantSubjectFor(question('b.patch')))).toBe(
      false,
    );
    expect(await openQuestionFor(approvals, question('b.patch'), MOMENT)).toBeNull();
  });

  it('covers the whole action where it destroys nothing', async () => {
    const dir = await home();
    const approvals = new PendingApprovals(dir);
    const write = { ...question('a.ts', 'write'), action: 'filesystem.write' };
    const held = await holdInChat(approvals, write, 'both', MOMENT);
    await approvals.answer(held.id, 'session', 'Moise', MOMENT);
    const other = { ...write, target: 'b.ts' };
    expect(await new FileGrants(dir).covers(grantSubjectFor(other))).toBe(true);
  });

  it('tells the agent and the person that a delete was allowed on one file only', async () => {
    const dir = await home();
    const approvals = new PendingApprovals(dir);
    const held = await holdInChat(approvals, question('a.patch'), 'both', MOMENT);
    const outcome = await approvals.answer(held.id, 'session', 'Moise', MOMENT);
    const answered = outcome !== null && 'answered' in outcome ? outcome.answered : held;
    expect(answeredText(answered)).toBe(
      `Memnox: Moise said yes for the rest of this session: you may delete a.patch (${held.id}). Any other delete still needs their OK. Try the same call again now and carry on.`,
    );
    expect(heldNotice(held)).toContain(
      '2. Allow for this session (this a.patch only; any other delete still asks)',
    );
    expect(heldNotice(held)).toContain('also sent to your Slack or Discord');
  });
});
