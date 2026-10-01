import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  ACTION,
  HOLD_ANSWER,
  Milestones,
  NodeGit,
  NodeWorktree,
  PendingApprovals,
  PROPOSAL_KIND,
  Proposals,
  selfProtection,
  SessionTasks,
  SqliteEventStore,
  type HoldRequest,
  type MemnoxEvent,
} from '@memnox/core';
import {
  callOperatorTool,
  OPERATOR_CATALOGUE,
  OPERATOR_TOOLS,
} from '../src/session-tools/operator-tools';
import { OPERATOR_AGENT } from '../src/session-tools/propose-tools';
import type { SessionToolDeps } from '../src/session-tools/read-tools';
import type { RewindSeams } from '../src/session-tools/rewind-tool';
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

function milestonesIn(place: string): Milestones {
  return new Milestones(new NodeGit(place), new NodeWorktree(place));
}

const SEAMS: RewindSeams = {
  build: milestonesIn,
  unattended: () => true,
  terminal: () => false,
  confirm: async () => null,
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
    milestonesAt: async (place) =>
      milestonesIn(place)
        .list()
        .catch(() => []),
    brief: async () => null,
  };
}

function event(
  sessionId: string,
  agent: string,
  over: Partial<MemnoxEvent>,
): MemnoxEvent {
  return {
    id: `evt_${sessionId}_${over.operation ?? 'x'}_${over.at ?? ''}`,
    schemaVersion: 1,
    at: '2026-09-30T11:00:00.000Z',
    sessionId,
    agent,
    actorType: 'agent',
    surface: 'filesystem',
    operation: 'filesystem.write',
    class: 'write',
    effect: 'allow',
    mode: 'enforce',
    reason: 'no rule matched',
    ...over,
  };
}

async function recorded(home: string, events: MemnoxEvent[]): Promise<void> {
  const store = SqliteEventStore.forHome(home);
  for (const each of events) await store.append(each);
  store.close();
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'ignore',
  });
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

    const answer = await callOperatorTool(deps, SEAMS, 'propose_answer', {
      call: held.id,
      answer: HOLD_ANSWER.DENY,
      said: 'no, not on main',
    });

    expect(answer).toMatchObject({ answered: held.id, answer: HOLD_ANSWER.DENY });
    expect((await new PendingApprovals(deps.home).read(held.id))?.answer).toBe(
      HOLD_ANSWER.DENY,
    );
    const store = SqliteEventStore.forHome(deps.home);
    const rows = await store.query({ sessionId: HELD.sessionId, limit: 10 });
    store.close();
    expect(rows[0]?.reason).toContain('saying "no, not on main"');
  });

  it("only proposes an allow, keeping the person's words, and leaves the call held", async () => {
    const deps = await depsAt();
    const held = await new PendingApprovals(deps.home).raise(
      HELD,
      NOW.toISOString(),
      TWO_MINUTES,
    );

    const answer = await callOperatorTool(deps, SEAMS, 'propose_answer', {
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
      await callOperatorTool(deps, SEAMS, 'propose_answer', {
        call: held.id,
        answer: 'edit',
      }),
    ).toHaveProperty('refused');
    expect(
      await callOperatorTool(deps, SEAMS, 'propose_answer', {
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

    const answer = await callOperatorTool(deps, SEAMS, 'propose_rule', {
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
    const answer = await callOperatorTool(deps, SEAMS, 'propose_rule', {
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
      await callOperatorTool(deps, SEAMS, 'propose_rule', {
        action: 'npm.publish',
        effect: 'sort-of',
        project: deps.home,
      }),
    ).toHaveProperty('refused');
  });

  it('asks for the project rather than guessing when none has a rule file', async () => {
    const deps = await depsAt();
    expect(
      await callOperatorTool(deps, SEAMS, 'propose_rule', {
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

describe('more than one session at once', () => {
  it('lists every session, so two Claude sessions are two rows and not the newest one', async () => {
    const deps = await depsAt();
    await recorded(deps.home, [
      event('ses_checkout', 'claude-code', { at: '2026-09-30T11:00:00.000Z' }),
      event('ses_api', 'claude-code', { at: '2026-09-30T11:30:00.000Z' }),
      event('ses_codex', 'codex', { at: '2026-09-30T11:45:00.000Z' }),
    ]);
    await new SessionTasks(deps.home).declare({
      id: 'tsk_1',
      sessionId: 'ses_checkout',
      statement: 'add order cancellation',
      scope: {},
      declaredAt: '2026-09-30T10:59:00.000Z',
    });

    const claude = (await callOperatorTool(deps, SEAMS, 'sessions', {
      agent: 'claude-code',
    })) as { session: string; task?: string; quietForMinutes: number }[];

    expect(claude.map((each) => each.session)).toEqual(['ses_api', 'ses_checkout']);
    expect(claude[1]?.task).toBe('add order cancellation');
    expect(claude[0]?.quietForMinutes).toBe(30);
    const everyone = (await callOperatorTool(deps, SEAMS, 'sessions', {})) as unknown[];
    expect(everyone).toHaveLength(3);
  });

  it('says the catch-all session is this Mac and not an agent', async () => {
    const deps = await depsAt();
    await recorded(deps.home, [
      event('ses_local', 'an agent', { surface: 'git', operation: 'git.unknown' }),
    ]);
    const rows = (await callOperatorTool(deps, SEAMS, 'sessions', {})) as {
      notAnAgent?: string;
    }[];
    expect(rows[0]?.notAnAgent).toContain('outside any agent session');
  });

  it('never reads its own run as the session the person asked about', async () => {
    const deps = await depsAt();
    await recorded(deps.home, [event('ses_work', 'claude-code', {})]);
    const answer = await callOperatorTool(
      { ...deps, env: { MEMNOX_SESSION: 'ses_operator_itself' } },
      SEAMS,
      'replay',
      { agent: 'claude-code' },
    );
    expect(answer).toMatchObject({ sessionId: 'ses_work' });
  });
});

describe('what a session changed in the code', () => {
  it('lists the files it changed since its first write, and the diff of one', async () => {
    const deps = await depsAt();
    const repo = await mkdtemp(join(tmpdir(), 'memnox-operator-repo-'));
    git(repo, 'init', '-q');
    await writeFile(join(repo, 'orders.ts'), 'export const orders = [];\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'start');
    await milestonesIn(repo).take({ at: '2026-09-30T11:00:00.000Z', sessionId: 'ses_1' });
    await writeFile(
      join(repo, 'orders.ts'),
      'export const orders = [];\nexport function cancel(): void {}\n',
    );
    await writeFile(join(repo, 'cancel.test.ts'), 'test();\n');
    await recorded(deps.home, [
      event('ses_1', 'claude-code', { target: join(repo, 'orders.ts') }),
    ]);

    const files = (await callOperatorTool(deps, SEAMS, 'changes', {
      agent: 'claude-code',
    })) as { files: { total: number; shown: { path: string; status: string }[] } };
    expect(files.files.shown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'cancel.test.ts', status: 'A', added: 1 }),
        expect.objectContaining({ path: 'orders.ts', status: 'M', added: 1, removed: 0 }),
      ]),
    );

    const diff = (await callOperatorTool(deps, SEAMS, 'changes', {
      agent: 'claude-code',
      path: 'orders.ts',
    })) as { diff: { lines: string[] } };
    expect(diff.diff.lines).toContain('+export function cancel(): void {}');
    // Only objects were written, so the person's own index and refs never moved.
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }),
    ).toContain('?? cancel.test.ts');
  });

  it('compares with the last commit when no milestone was taken, and shows only its own files', async () => {
    const deps = await depsAt();
    const repo = await mkdtemp(join(tmpdir(), 'memnox-operator-repo-'));
    git(repo, 'init', '-q');
    await writeFile(join(repo, 'orders.ts'), 'export const orders = [];\n');
    await writeFile(join(repo, 'other.ts'), 'one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'start');
    await writeFile(
      join(repo, 'orders.ts'),
      'export const orders = [];\nexport function cancel(): void {}\n',
    );
    await writeFile(join(repo, 'other.ts'), 'somebody else\n');
    await recorded(deps.home, [
      event('ses_3', 'claude-code', { target: join(repo, 'orders.ts') }),
    ]);

    const answer = (await callOperatorTool(deps, SEAMS, 'changes', {
      agent: 'claude-code',
    })) as { comparedWith: string; files: { shown: { path: string }[] } };
    expect(answer.comparedWith).toContain('the last commit');
    expect(answer.files.shown.map((each) => each.path)).toEqual(['orders.ts']);

    const diff = (await callOperatorTool(deps, SEAMS, 'changes', {
      agent: 'claude-code',
      path: 'orders.ts',
    })) as { diff: { lines: string[] } };
    expect(diff.diff.lines).toContain('+export function cancel(): void {}');
  });

  it('says so when no milestone was taken, rather than inventing a diff', async () => {
    const deps = await depsAt();
    await recorded(deps.home, [event('ses_2', 'claude-code', {})]);
    expect(
      await callOperatorTool(deps, SEAMS, 'changes', { agent: 'claude-code' }),
    ).toMatchObject({ found: false });
  });
});

describe('what a session reached outside the machine', () => {
  it('names the hosts it fetched and the MCP tools it called, for the session asked about', async () => {
    const deps = await depsAt();
    await recorded(deps.home, [
      event('ses_4', 'claude-code', {
        surface: 'network',
        operation: 'http.request',
        target: 'api.github.com',
        class: 'read',
      }),
      event('ses_4', 'claude-code', {
        at: '2026-09-30T11:05:00.000Z',
        surface: 'mcp',
        operation: 'mcp.linear.list_issues',
        class: 'read',
      }),
    ]);
    const answer = (await callOperatorTool(deps, SEAMS, 'outside', {
      agent: 'claude-code',
    })) as { contacts: { kind: string; name: string; operations: string[] }[] };
    expect(
      answer.contacts.map((each) => [each.kind, each.name, each.operations]),
    ).toEqual([
      ['mcp', 'linear', ['list_issues']],
      ['web', 'api.github.com', ['http.request']],
    ]);
  });
});
