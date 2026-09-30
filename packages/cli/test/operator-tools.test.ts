import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  ACTION,
  HOLD_ANSWER,
  PendingApprovals,
  PROPOSAL_KIND,
  Proposals,
  selfProtection,
  type HoldRequest,
} from '@memnox/core';
import {
  callOperatorTool,
  OPERATOR_CATALOGUE,
  OPERATOR_TOOLS,
} from '../src/session-tools/operator-tools';
import { OPERATOR_AGENT } from '../src/session-tools/propose-tools';
import type { SessionToolDeps } from '../src/session-tools/read-tools';
import { serveSession } from '../src/session-tools/session-server';

/**
 * The voice's brain reads everything and writes only proposals. These are the tests that
 * would fail the day one of its tools could put something in force on its own.
 */

const NOW = new Date('2026-09-30T12:00:00.000Z');
const TWO_MINUTES = 120_000;

const HELD: HoldRequest = {
  sessionId: 'ses_1',
  agent: 'claude-code',
  operation: 'git.push',
  target: 'main',
  fingerprint: 'abc123def456',
  reason: 'pushing to main needs a person',
};

async function depsAt(): Promise<SessionToolDeps> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-operator-'));
  return {
    home,
    cwd: home,
    agent: 'unknown-agent',
    env: {},
    now: () => NOW,
    readStatus: async () => ({ mode: 'enforce' }),
    milestonesAt: async () => [],
    brief: async () => null,
  };
}

describe('what the operator is offered', () => {
  it('reads, and writes nothing but a proposal', () => {
    for (const tool of OPERATOR_TOOLS) {
      if (tool.annotations.readOnlyHint) continue;
      expect(tool.name).toMatch(/^propose_/);
    }
  });

  it('offers nothing that allows, approves, grants or trusts outright', () => {
    for (const tool of OPERATOR_TOOLS) {
      for (const word of ['allow', 'approve', 'grant', 'trust', 'unfreeze', 'mode']) {
        expect(tool.name).not.toContain(word);
      }
    }
  });

  it('is governed like any agent: it may not approve or write what governs it', () => {
    expect(
      selfProtection({ action: 'memnox.approve', target: 'approve apr_1' }),
    ).not.toBeNull();
    expect(
      selfProtection({
        action: ACTION.FILESYSTEM_WRITE,
        target: '/Users/someone/.memnox/proposals/prp_1.json',
      }),
    ).not.toBeNull();
    expect(
      selfProtection({
        action: ACTION.FILESYSTEM_WRITE,
        target: '/work/shop/memnox.policies.toml',
      }),
    ).not.toBeNull();
  });
});

describe('answering a held call from what the person said', () => {
  it('refuses at once on a deny, since saying no can do no harm', async () => {
    const deps = await depsAt();
    const held = await new PendingApprovals(deps.home).raise(
      HELD,
      NOW.toISOString(),
      TWO_MINUTES,
    );

    const answer = await callOperatorTool(deps, 'propose_answer', {
      call: held.id,
      answer: HOLD_ANSWER.DENY,
      said: 'no, not on main',
    });

    expect(answer).toMatchObject({ answered: held.id, answer: HOLD_ANSWER.DENY });
    expect((await new PendingApprovals(deps.home).read(held.id))?.answer).toBe(
      HOLD_ANSWER.DENY,
    );
  });

  it("only proposes an allow, keeping the person's words, and leaves the call held", async () => {
    const deps = await depsAt();
    const held = await new PendingApprovals(deps.home).raise(
      HELD,
      NOW.toISOString(),
      TWO_MINUTES,
    );

    const answer = await callOperatorTool(deps, 'propose_answer', {
      call: held.id,
      answer: HOLD_ANSWER.ONCE,
      said: 'yeah go ahead, just this once',
    });

    expect(answer).toHaveProperty('proposed');
    expect((await new PendingApprovals(deps.home).read(held.id))?.answer).toBeUndefined();
    const [proposal] = await new Proposals(deps.home).open(NOW.toISOString());
    expect(proposal).toMatchObject({
      rationale: 'yeah go ahead, just this once',
      proposedBy: OPERATOR_AGENT,
      change: {
        kind: PROPOSAL_KIND.ANSWER,
        pendingId: held.id,
        answer: HOLD_ANSWER.ONCE,
      },
    });
    // Never outlives the call it answers.
    expect(proposal?.expiresAt).toBe(held.expiresAt);
  });

  it('turns down an answer a voice cannot give, and a call nobody is waiting on', async () => {
    const deps = await depsAt();
    const held = await new PendingApprovals(deps.home).raise(
      HELD,
      NOW.toISOString(),
      TWO_MINUTES,
    );

    expect(
      await callOperatorTool(deps, 'propose_answer', { call: held.id, answer: 'edit' }),
    ).toHaveProperty('refused');
    expect(
      await callOperatorTool(deps, 'propose_answer', {
        call: 'apr_gone',
        answer: 'deny',
      }),
    ).toHaveProperty('refused');
  });
});

describe('a rule the person asked for', () => {
  it('is proposed and never written, so it is not in force until Touch ID', async () => {
    const deps = await depsAt();
    const project = join(deps.home, 'shop');

    const answer = await callOperatorTool(deps, 'propose_rule', {
      action: 'npm.publish',
      effect: 'deny',
      reason: 'nobody publishes from a laptop',
      project,
    });

    expect(answer).toMatchObject({
      rule: { name: 'voice-deny-npm-publish', action: 'npm.publish', effect: 'deny' },
    });
    expect(existsSync(join(project, 'memnox.policies.toml'))).toBe(false);
    const [proposal] = await new Proposals(deps.home).open(NOW.toISOString());
    expect(proposal?.change.kind).toBe(PROPOSAL_KIND.RULES);
  });

  it('names a spoken command the way the engine rules on it', async () => {
    const deps = await depsAt();
    const answer = await callOperatorTool(deps, 'propose_rule', {
      action: 'railway deploy',
      effect: 'deny',
      project: deps.home,
    });
    expect(answer).toMatchObject({
      rule: { action: expect.stringMatching(/^railway\./) },
    });
  });

  it('refuses an effect the engine does not know', async () => {
    const deps = await depsAt();
    expect(
      await callOperatorTool(deps, 'propose_rule', {
        action: 'npm.publish',
        effect: 'sort-of',
        project: deps.home,
      }),
    ).toHaveProperty('refused');
  });

  it('asks for the project rather than guessing when none has a rule file', async () => {
    const deps = await depsAt();
    expect(
      await callOperatorTool(deps, 'propose_rule', {
        action: 'npm.publish',
        effect: 'deny',
      }),
    ).toHaveProperty('refused');
  });
});

describe('the operator on the wire', () => {
  it('introduces itself as the operator and lists its own tools', async () => {
    const deps = await depsAt();
    const input = new PassThrough();
    const output = new PassThrough();
    const replies: { id?: number; result?: Record<string, unknown> }[] = [];
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      for (const line of chunk.split('\n').filter((each) => each !== '')) {
        const reply = JSON.parse(line) as {
          id?: number;
          result?: Record<string, unknown>;
        };
        replies.push(reply);
        if (reply.id === 2) input.end();
      }
    });
    const served = serveSession({
      input,
      output,
      deps,
      seams: {
        // Listing tools never rewinds, so the milestone builder is never reached.
        build: () => null as never,
        unattended: () => true,
        terminal: () => false,
      },
      catalogue: OPERATOR_CATALOGUE,
    });
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
    );
    await served;

    const info = replies.find((each) => each.id === 1)?.result?.['serverInfo'];
    expect(info).toMatchObject({ name: 'memnox-operator' });
    const tools = replies.find((each) => each.id === 2)?.result?.['tools'] as {
      name: string;
    }[];
    expect(tools.map((each) => each.name)).toContain('propose_rule');
  });
});
