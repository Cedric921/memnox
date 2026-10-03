import { describe, expect, it } from 'vitest';
import type { DaemonAskChunk } from '@memnox/core';
import { BRAIN_CHUNK, type Brain, type BrainChunk } from '../src/operator/brain';
import { AddressLimit } from '../src/daemon/address-limit';
import { BrainTurns } from '../src/daemon/brain-turns';
import { SpokenFilter } from '../src/daemon/spoken-filter';
import { streamTurn } from '../src/daemon/stream-turn';
import { waitingRoute } from '../src/session-tools/instruct-tools';

function spoken(pieces: readonly (string | null)[]): string {
  const filter = new SpokenFilter();
  let out = '';
  for (const piece of pieces) {
    if (piece === null) filter.tool();
    else out += filter.text(piece);
  }
  return out + filter.end();
}

describe('what of the brain is said aloud', () => {
  it('never says a system reminder the model echoed, however it was split', () => {
    expect(
      spoken([
        '<system',
        '-reminder>',
        '\n<total_tokens',
        '>15000000',
        '</total_tokens',
        '>\n</system',
        '-reminder>',
        '\n\nYour',
        ' last session was checking git.',
      ]),
    ).toBe('\n\nYour last session was checking git.');
  });

  it('keeps a lone angle bracket that starts no reminder', () => {
    expect(spoken(['Three ', '<', ' five.'])).toBe('Three < five.');
    expect(spoken(['It ends in <'])).toBe('It ends in <');
  });

  it('drops the sentence said again after a tool, as in the voice log', () => {
    expect(
      spoken([
        'My',
        ' apologies;',
        ' the instruction is on your clipboard instead. Would',
        ' you like me to open that session?',
        null,
        'My',
        ' ap',
        'ologies;',
        ' the instruction is on your',
        ' clipboard instead. Would you like me to open that session?',
      ]),
    ).toBe(
      'My apologies; the instruction is on your clipboard instead. Would you like me to open that session?',
    );
  });

  it('says what comes after a tool once it differs from what was said', () => {
    expect(
      spoken([
        "I'll close all the sessions.",
        null,
        'I',
        "'ll need you to close the VS Code one.",
      ]),
    ).toBe("I'll close all the sessions.I'll need you to close the VS Code one.");
  });

  it('streams the turn without the repeat, and records only what was said', async () => {
    const chunks: BrainChunk[] = [
      { kind: BRAIN_CHUNK.TEXT, text: 'Sorry, it is on your clipboard.' },
      { kind: BRAIN_CHUNK.TOOL, tool: 'mcp__memnox-operator__end_conversation' },
      { kind: BRAIN_CHUNK.TEXT, text: 'Sorry, it is on your clipboard.' },
      { kind: BRAIN_CHUNK.DONE },
    ];
    const brain: Brain = {
      name: 'claude',
      async *ask() {
        yield* chunks;
      },
      close: () => undefined,
      cancel: () => undefined,
      warm: async () => undefined,
    };
    const sent: DaemonAskChunk[] = [];
    const turn = await streamTurn(new BrainTurns(() => brain, 60_000), 'yes', (chunk) =>
      sent.push(chunk),
    );
    expect(turn.answered).toBe('Sorry, it is on your clipboard.');
    expect(sent.filter((chunk) => chunk.kind === BRAIN_CHUNK.TEXT)).toHaveLength(1);
  });
});

describe('addressing the person', () => {
  it('takes their name out once it was said lately, however the name is split', () => {
    const filter = new SpokenFilter([', Moïse', 'Moïse, ']);
    const out = ['My apologies,', ' Mo', 'ï', 'se. Most', ' of these are in VS Code.']
      .map((piece) => filter.text(piece))
      .join('');
    expect(out + filter.end()).toBe('My apologies. Most of these are in VS Code.');
    const opening = new SpokenFilter([', sir', 'sir, ']);
    expect(opening.text('Very well, sir.') + opening.end()).toBe('Very well.');
  });

  it('lets the name through once, then not again for ten minutes', () => {
    const limit = new AddressLimit('/nowhere');
    const names = ['Moïse'];
    expect(limit.unsaid(names, '2026-10-02T22:49:00.000Z')).toEqual([]);
    limit.noteSaid('Opening it now, Moïse.', names, '2026-10-02T22:49:40.000Z');
    expect(limit.unsaid(names, '2026-10-02T22:50:00.000Z')).toEqual([
      ', Moïse',
      'Moïse, ',
    ]);
    expect(limit.unsaid(names, '2026-10-02T23:00:00.000Z')).toEqual([]);
  });

  it('says a name that only starts like the phrase as it is', () => {
    const filter = new SpokenFilter([', Moïse']);
    expect(
      filter.text('Moments ago, Mo') + filter.text('nday came.') + filter.end(),
    ).toBe('Moments ago, Monday came.');
  });
});

describe('a turn the brain ends after speaking', () => {
  it('never says a second wording of it after end_conversation, as in the voice log', async () => {
    const chunks: BrainChunk[] = [
      { kind: BRAIN_CHUNK.TEXT, text: 'I see. So only two agents were onboarded.' },
      { kind: BRAIN_CHUNK.TOOL, tool: 'mcp__memnox-operator__end_conversation' },
      {
        kind: BRAIN_CHUNK.TEXT,
        text: 'I understand. So only two of the three were onboarded.',
      },
      { kind: BRAIN_CHUNK.DONE },
    ];
    const brain: Brain = {
      name: 'claude',
      async *ask() {
        yield* chunks;
      },
      close: () => undefined,
      cancel: () => undefined,
      warm: async () => undefined,
    };
    const sent: DaemonAskChunk[] = [];
    const turn = await streamTurn(new BrainTurns(() => brain, 60_000), 'yes', (chunk) =>
      sent.push(chunk),
    );
    expect(turn.answered).toBe('I see. So only two agents were onboarded.');
    expect(sent.map((chunk) => chunk.kind)).toEqual(['text', 'tool', 'done']);
  });

  it('keeps listening after a reply that asks something, even when the brain ended it', async () => {
    const chunks: BrainChunk[] = [
      { kind: BRAIN_CHUNK.TEXT, text: "I'm here. What can I do for you?" },
      { kind: BRAIN_CHUNK.TOOL, tool: 'mcp__memnox-operator__end_conversation' },
      { kind: BRAIN_CHUNK.DONE },
    ];
    const brain: Brain = {
      name: 'claude',
      async *ask() {
        yield* chunks;
      },
      close: () => undefined,
      cancel: () => undefined,
      warm: async () => undefined,
    };
    const sent: DaemonAskChunk[] = [];
    await streamTurn(new BrainTurns(() => brain, 60_000), 'oh, you?', (chunk) =>
      sent.push(chunk),
    );
    expect(sent.map((chunk) => chunk.kind)).toEqual(['text', 'done']);
  });

  it('still says a sign off written after ending, when nothing was said before it', async () => {
    const chunks: BrainChunk[] = [
      { kind: BRAIN_CHUNK.TOOL, tool: 'mcp__memnox-operator__end_conversation' },
      { kind: BRAIN_CHUNK.TEXT, text: 'Very well.' },
      { kind: BRAIN_CHUNK.DONE },
    ];
    const brain: Brain = {
      name: 'claude',
      async *ask() {
        yield* chunks;
      },
      close: () => undefined,
      cancel: () => undefined,
      warm: async () => undefined,
    };
    const turn = await streamTurn(
      new BrainTurns(() => brain, 60_000),
      'ok',
      () => undefined,
    );
    expect(turn.answered).toBe('Very well.');
  });
});

describe('how an instruction reaches a session waiting on the person', () => {
  const agentInFront = (): boolean => true;
  const host = { sessionId: 's', agent: 'claude-code', pid: 1, seenAt: '' };

  it('types into an agent in an editor terminal, as in a Terminal tab', () => {
    expect(
      waitingRoute({ ...host, app: 'Visual Studio Code', tty: 'ttys013' }, agentInFront),
    ).toBe('typed');
    expect(waitingRoute({ ...host, app: 'iTerm2', tty: 'ttys004' }, agentInFront)).toBe(
      'typed',
    );
  });

  it('prefills only the chat panel, and never a terminal with a bare shell in front', () => {
    expect(waitingRoute({ ...host, app: 'Visual Studio Code' }, agentInFront)).toBe(
      'prefilled',
    );
    expect(
      waitingRoute({ ...host, app: 'Visual Studio Code', tty: 'ttys013' }, () => false),
    ).toBe('later');
  });
});
