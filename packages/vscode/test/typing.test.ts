import { describe, expect, it } from 'vitest';
import {
  agentInFront,
  keyPausesMs,
  typableText,
  typeLinkOf,
  waitingRequest,
} from '../src/typing';

const NOW = '2026-10-02T19:47:00.000Z';

const waiting = {
  id: 'dsp_murdjtg4_ceeee04e',
  display: 'type',
  text: 'push the runtime changes to GitHub',
  tty: 'ttys013',
  expiresAt: '2026-10-02T19:47:30.000Z',
};

describe('typing an instruction into an integrated terminal', () => {
  it('takes only a request id and a device from a link, never words', () => {
    expect(typeLinkOf('request=dsp_murdjtg4_ceeee04e&tty=ttys013')).toEqual({
      request: 'dsp_murdjtg4_ceeee04e',
      tty: 'ttys013',
    });
    expect(typeLinkOf('request=../../.ssh/id_rsa&tty=ttys013')).toBeNull();
    expect(typeLinkOf('request=dsp_a_b1&tty=ttys013;rm')).toBeNull();
    expect(typeLinkOf('text=rm%20-rf&tty=ttys013')).toBeNull();
  });

  it('types the words of a request still waiting for that very terminal', () => {
    expect(typableText(waiting, '/dev/ttys013', NOW)).toEqual({
      text: 'push the runtime changes to GitHub',
    });
    expect(typableText({ ...waiting, text: 'one\ntwo' }, 'ttys013', NOW)).toEqual({
      text: 'one two',
    });
  });

  it('refuses a request already typed, gone stale, of another kind or aimed elsewhere', () => {
    const delivered = { ...waiting, delivered: { outcome: 'typed', at: NOW } };
    expect(typableText(delivered, 'ttys013', NOW)).toEqual({
      why: 'it was already answered',
    });
    expect(typableText(waiting, 'ttys013', '2026-10-02T19:48:00.000Z')).toHaveProperty(
      'why',
    );
    expect(typableText({ ...waiting, display: 'card' }, 'ttys013', NOW)).toHaveProperty(
      'why',
    );
    expect(typableText(waiting, 'ttys004', NOW)).toEqual({
      why: 'the link named a different terminal',
    });
    expect(typableText(null, 'ttys013', NOW)).toEqual({ why: 'its request is gone' });
  });

  it('types only where a coding agent is the program in front', () => {
    expect(agentInFront('Ss   -zsh\nS+   claude\n')).toBe(true);
    expect(agentInFront('Ss+  -zsh\nS    claude\n')).toBe(false);
    expect(agentInFront('')).toBe(false);
  });

  it('types a few sentences in about three seconds, pausing after punctuation', () => {
    const pauses = keyPausesMs('push it, then stop.', () => 0.5);
    expect(pauses).toHaveLength(19);
    expect(pauses[7]).toBeGreaterThan(pauses[6] ?? 0);
    const long = keyPausesMs('x'.repeat(300), () => 0.5);
    expect(long.reduce((sum, each) => sum + each, 0)).toBeLessThanOrEqual(3_000);
  });

  it('closes only a terminal Memnox asked to close, never one a typing link names', () => {
    const closing = { ...waiting, display: 'close', text: undefined };
    expect(waitingRequest(closing, 'ttys013', NOW, 'close')).toHaveProperty('request');
    expect(waitingRequest(waiting, 'ttys013', NOW, 'close')).toEqual({
      why: 'it is not a request to close',
    });
    expect(waitingRequest(closing, 'ttys004', NOW, 'close')).toEqual({
      why: 'the link named a different terminal',
    });
  });
});
