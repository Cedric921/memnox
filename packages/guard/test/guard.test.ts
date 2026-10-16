import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { PublishedBundle, PublishedRule } from '@memnox/core/engine';

import { Guard, argsDigestOf, type GuardOptions } from '../src/guard';
import type {
  BundleFetch,
  CloudKey,
  CloudPort,
  GuardRecord,
  HeldAsk,
  HeldRaised,
  HeldState,
} from '../src/cloud';
import { HELD_ANSWER, HELD_STATUS, type HeldAnswer } from '../src/guard.constants';

const KEY_ID = 'k1';

interface Answer {
  answer: HeldAnswer;
  by: string;
  door: string;
  /** Sign it as the control plane would; false sends it unsigned. */
  signed?: boolean;
  proof?: string;
}

/** The control plane in memory: it serves signed rules, holds questions, and answers them as told. */
class FakeCloud implements CloudPort {
  readonly raised: HeldAsk[] = [];
  readonly recorded: GuardRecord[] = [];
  answer: Answer | null = null;
  reachable = true;
  private readonly privateKey: KeyObject;
  private readonly publicKey: string;

  constructor(
    private readonly rules: PublishedRule[] = [],
    private readonly badSignature = false,
  ) {
    const pair = generateKeyPairSync('ed25519');
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64');
  }

  async bundle(etag: string | null): Promise<BundleFetch | null> {
    if (!this.reachable) throw new Error('unreachable');
    const bundle: PublishedBundle = { hash: 'b1', rules: this.rules };
    if (etag === bundle.hash) return null;
    const body = JSON.stringify(bundle);
    const signedBody = this.badSignature ? `${body} ` : body;
    return {
      bundle,
      etag: bundle.hash,
      body,
      signature: `${KEY_ID}:${this.signText(signedBody)}`,
    };
  }

  async raise(ask: HeldAsk): Promise<HeldRaised> {
    if (!this.reachable) throw new Error('unreachable');
    this.raised.push(ask);
    return { id: `apr_${this.raised.length}`, expiresAt: '2026-10-07T10:30:00.000Z' };
  }

  async status(id: string): Promise<HeldState> {
    const ask = this.raised.at(-1);
    if (this.answer === null || ask === undefined)
      return { id, status: HELD_STATUS.PENDING };
    const payload = JSON.stringify({
      callId: id,
      answer: this.answer.answer,
      argsDigest: ask.argsDigest,
      proof: this.answer.proof ?? 'none',
    });
    return {
      id,
      status: HELD_STATUS.ANSWERED,
      answer: this.answer.answer,
      by: this.answer.by,
      door: this.answer.door,
      ...(this.answer.signed === false
        ? {}
        : { signed: { payload, signature: this.signText(payload), keyId: KEY_ID } }),
    };
  }

  async keys(): Promise<CloudKey[]> {
    return [{ keyId: KEY_ID, publicKey: this.publicKey }];
  }

  async record(rows: readonly GuardRecord[]): Promise<void> {
    this.recorded.push(...rows);
  }

  resumedAt: number | null = null;

  async resumedSince(_sessionId: string, sinceMs: number): Promise<boolean> {
    return this.resumedAt !== null && this.resumedAt >= sinceMs;
  }

  private signText(text: string): string {
    return sign(null, Buffer.from(text, 'utf8'), this.privateKey).toString('base64');
  }
}

/** A clock that moves half a minute every time it is read, so a wait runs out in a few polls. */
function racingClock(): () => Date {
  let at = Date.parse('2026-10-07T10:00:00.000Z');
  return () => {
    at += 30_000;
    return new Date(at);
  };
}

function guardOn(cloud: FakeCloud, options: Partial<GuardOptions> = {}): Guard {
  return new Guard(cloud, { agent: 'support-bot', ...options }).start();
}

const SESSION = { sessionId: 's1' };
const REFUND = 'mcp__stripe__create_refund';
const REFUND_INPUT = { payment_intent: 'pi_3Qx8', amount: 420000 };

describe('a guard on an agent in the cloud', () => {
  it('lets a read run with no question asked and no wait', async () => {
    const cloud = new FakeCloud();
    const decision = await guardOn(cloud).authorize(
      'mcp__linear__list_issues',
      {},
      SESSION,
    );
    expect(decision.allowed).toBe(true);
    expect(cloud.raised).toEqual([]);
  });

  it('refuses what a workspace rule denies, naming the rule and what to do instead', async () => {
    const cloud = new FakeCloud([
      {
        id: 'no-repo-deletes',
        effect: 'deny',
        match: 'mcp.github.delete_repo',
        reason: 'deleting a repository loses its history',
        alternative: 'archive the repository instead',
      },
    ]);
    const decision = await guardOn(cloud).authorize(
      'mcp__github__delete_repo',
      { repo: 'shop' },
      SESSION,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe('no-repo-deletes');
    expect(decision.alternative).toBe('archive the repository instead');
    expect(cloud.raised).toEqual([]);
  });

  it('asks a person for a refund and runs it once they allow it, carrying only a digest of the arguments', async () => {
    const cloud = new FakeCloud();
    cloud.answer = { answer: HELD_ANSWER.ONCE, by: 'Maya', door: 'iPhone' };
    const decision = await guardOn(cloud).authorize(REFUND, REFUND_INPUT, SESSION);
    expect(decision.allowed).toBe(true);
    expect(decision.answeredBy).toBe('Maya on iPhone');
    expect(cloud.raised[0]?.operation).toBe('mcp.stripe.create_refund');
    expect(cloud.raised[0]?.argsDigest).toBe(argsDigestOf(REFUND_INPUT));
    expect(JSON.stringify(cloud.raised[0])).not.toContain('pi_3Qx8');
  });

  it('refuses when the person says no, and says who', async () => {
    const cloud = new FakeCloud();
    cloud.answer = { answer: HELD_ANSWER.DENY, by: 'Maya', door: 'Slack' };
    const decision = await guardOn(cloud).authorize(REFUND, REFUND_INPUT, SESSION);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('denied by Maya on Slack');
  });

  it('does not believe a yes the control plane did not sign', async () => {
    const cloud = new FakeCloud();
    cloud.answer = { answer: HELD_ANSWER.ONCE, by: 'Maya', door: 'Slack', signed: false };
    const decision = await guardOn(cloud).authorize(REFUND, REFUND_INPUT, SESSION);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('not signed');
  });

  it('refuses a chat button yes where a device must vouch, and takes one an iPhone signed', async () => {
    const cloud = new FakeCloud();
    cloud.answer = { answer: HELD_ANSWER.ONCE, by: 'Maya', door: 'Slack' };
    const strict = guardOn(cloud, { requireDeviceProof: true });
    const chat = await strict.authorize(REFUND, REFUND_INPUT, SESSION);
    expect(chat.allowed).toBe(false);
    expect(chat.reason).toContain('no device or passkey signed it');
    cloud.answer = {
      answer: HELD_ANSWER.ONCE,
      by: 'Maya',
      door: 'iPhone',
      proof: 'device',
    };
    const phone = await strict.authorize(REFUND, { ...REFUND_INPUT, amount: 1 }, SESSION);
    expect(phone.allowed).toBe(true);
    expect(phone.answerProof).toBe('device');
  });

  it('refuses once nobody answers within the wait, rather than waiting for ever', async () => {
    const cloud = new FakeCloud();
    const guard = guardOn(cloud, { waitMs: 90_000, now: racingClock() });
    const decision = await guard.authorize(REFUND, REFUND_INPUT, SESSION);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('nobody answered within 90 seconds');
  });

  it('fails closed on a question it cannot raise, and still decides everything else locally', async () => {
    const cloud = new FakeCloud();
    cloud.reachable = false;
    const guard = guardOn(cloud);
    const refund = await guard.authorize(REFUND, REFUND_INPUT, SESSION);
    const read = await guard.authorize('mcp__linear__list_issues', {}, SESSION);
    expect(refund.allowed).toBe(false);
    expect(refund.reason).toContain('could not be reached');
    expect(read.allowed).toBe(true);
  });

  it('takes a yes for the session as a yes for the same call again, without asking twice', async () => {
    const cloud = new FakeCloud();
    cloud.answer = { answer: HELD_ANSWER.SESSION, by: 'Bo', door: 'Discord' };
    const guard = guardOn(cloud);
    await guard.authorize(REFUND, REFUND_INPUT, SESSION);
    cloud.answer = null;
    const again = await guard.authorize(REFUND, REFUND_INPUT, SESSION);
    expect(again.allowed).toBe(true);
    expect(cloud.raised).toHaveLength(1);
  });

  it('pauses a session that fails the same way five times, until a person resumes it', async () => {
    const guard = guardOn(new FakeCloud());
    const migrate = { command: 'npx prisma migrate dev' };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      guard.outcome('Bash', migrate, SESSION, { failed: true, failureKind: 'P1001' });
    }
    const sixth = await guard.authorize('Bash', migrate, SESSION);
    expect(sixth.allowed).toBe(false);
    expect(sixth.reason).toContain('Memnox paused this session');
    guard.resume('s1');
    const ls = await guard.authorize('Bash', { command: 'ls' }, SESSION);
    expect(ls.allowed).toBe(true);
  });

  it('records the pause, and lets the session run again once a person resumes it from elsewhere', async () => {
    const cloud = new FakeCloud();
    const guard = guardOn(cloud, { now: racingClock() });
    const migrate = { command: 'npx prisma migrate dev' };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      guard.outcome('Bash', migrate, SESSION, { failed: true, failureKind: 'P1001' });
    }
    expect((await guard.authorize('Bash', { command: 'ls' }, SESSION)).allowed).toBe(
      false,
    );
    cloud.resumedAt = Date.parse('2026-10-08T00:00:00.000Z');
    expect((await guard.authorize('Bash', { command: 'ls' }, SESSION)).allowed).toBe(
      true,
    );
    await guard.close();
    expect(cloud.recorded.map((row) => row.kind)).toContain('agent.session.paused');
  });

  it('ignores rules whose signature does not match, keeping the rules it trusts', async () => {
    const cloud = new FakeCloud(
      [{ id: 'allow-everything', effect: 'allow', match: '**' }],
      true,
    );
    const guard = guardOn(cloud, { waitMs: 60_000, now: racingClock() });
    const decision = await guard.authorize(REFUND, REFUND_INPUT, SESSION);
    expect(cloud.raised).toHaveLength(1);
    expect(decision.allowed).toBe(false);
  });

  it('records each decision with the session, never the arguments', async () => {
    const cloud = new FakeCloud();
    const guard = guardOn(cloud);
    await guard.authorize('mcp__linear__list_issues', { query: 'secret-thing' }, SESSION);
    await guard.close();
    expect(cloud.recorded.map((row) => row.kind)).toEqual([
      'agent.session.started',
      'agent.action.recorded',
    ]);
    expect(JSON.stringify(cloud.recorded)).not.toContain('secret-thing');
    expect(cloud.recorded[1]?.payload['finalEffect']).toBe('allow');
  });

  it('decides a local verdict in well under a millisecond', async () => {
    const guard = guardOn(new FakeCloud());
    await guard.authorize('mcp__linear__list_issues', {}, SESSION);
    const rounds = 2_000;
    const started = performance.now();
    for (let index = 0; index < rounds; index += 1) {
      await guard.authorize('mcp__linear__list_issues', {}, SESSION);
    }
    expect((performance.now() - started) / rounds).toBeLessThan(1);
  });
});
