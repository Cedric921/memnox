import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionHosts } from '@memnox/core';
import {
  conversationIn,
  lastAnswerIn,
  sessionTranscript,
} from '../src/daemon/transcript';

const line = (value: unknown): string => JSON.stringify(value);

describe('the conversation in a live session window', () => {
  it('shows what was asked, what the agent said and ran, and never its thinking or a helper', () => {
    const raw = [
      line({
        type: 'user',
        timestamp: 't1',
        message: {
          content: '<system-reminder>ignore</system-reminder>\nadd a cancel button',
        },
      }),
      line({
        type: 'assistant',
        timestamp: 't2',
        message: { content: [{ type: 'thinking', thinking: 'private' }] },
      }),
      line({
        type: 'assistant',
        timestamp: 't3',
        message: {
          content: [
            { type: 'text', text: 'I will add it to the cart page.' },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/r/src/Cart.tsx' } },
          ],
        },
      }),
      line({
        type: 'user',
        timestamp: 't4',
        message: { content: [{ type: 'tool_result', content: 'ok' }] },
      }),
      line({
        type: 'assistant',
        isSidechain: true,
        timestamp: 't5',
        message: { content: [{ type: 'text', text: 'a helper talking' }] },
      }),
      '{"type":"assistant","message":{"con',
    ].join('\n');
    expect(conversationIn(raw)).toEqual([
      { at: 't1', who: 'person', text: 'add a cancel button' },
      { at: 't3', who: 'agent', text: 'I will add it to the cart page.' },
      { at: 't3', who: 'tool', text: 'Edit: Cart.tsx' },
    ]);
  });
});

describe('what a session answered last', () => {
  it('is the words after its last tool call, whole, and resets when the person asks again', () => {
    const said = (text: string): unknown => ({ type: 'text', text });
    const raw = [
      line({ type: 'user', message: { content: 'check the git history' } }),
      line({
        type: 'assistant',
        message: {
          content: [said('Let me look.'), { type: 'tool_use', name: 'Bash', input: {} }],
        },
      }),
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'x' }] },
      }),
      line({
        type: 'assistant',
        message: { content: [said('I read the last 40 commits on main.')] },
      }),
      line({ type: 'assistant', message: { content: [said('Two are from today.')] } }),
    ];
    expect(lastAnswerIn(raw.join('\n'))).toBe(
      'I read the last 40 commits on main.\n\nTwo are from today.',
    );
    const askedAgain = [...raw, line({ type: 'user', message: { content: 'and now?' } })];
    expect(lastAnswerIn(askedAgain.join('\n'))).toBeNull();
  });

  it('is found under memnox run through the id the agent gave its own transcript', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-transcript-'));
    const project = join(home, '.claude', 'projects', '-work-client');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, '9ddff478-4759-4ec5.jsonl'), '');
    expect(await sessionTranscript(home, 'ses_1eb61120-4c7')).toBeNull();
    await new SessionHosts(home).note({
      sessionId: 'ses_1eb61120-4c7',
      agent: 'claude-code',
      pid: 1,
      agentSession: '9ddff478-4759-4ec5',
      seenAt: '2026-10-02T08:17:02.000Z',
    });
    expect(await sessionTranscript(home, 'ses_1eb61120-4c7')).toBe(
      join(project, '9ddff478-4759-4ec5.jsonl'),
    );
  });
});
