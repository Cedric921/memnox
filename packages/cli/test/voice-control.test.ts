import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfirmKeys,
  confirmationMessage,
  DisplayRequests,
  Milestones,
  NodeGit,
  NodeWorktree,
  PROPOSAL_KIND,
  Proposals,
  SessionHosts,
  SessionTurns,
  SessionWatches,
  SpokenInstructions,
  SqliteEventStore,
  STARTABLE_AGENT,
  VoiceFocusStore,
  type DiscoveryReport,
  type MemnoxEvent,
} from '@memnox/core';
import { confirmAnswer } from '../src/daemon/confirm';
import { NoticeWatcher } from '../src/daemon/notice-watch';
import { testRunsIn } from '../src/daemon/transcript';
import { callOperatorTool } from '../src/session-tools/operator-tools';
import type { SessionToolDeps } from '../src/session-tools/read-tools';
import type { RewindSeams } from '../src/session-tools/rewind-tool';
import { showAgentsTool } from '../src/session-tools/agents-tool';
import { repositoryNamed } from '../src/session-tools/start-tools';

/**
 * The voice doing things rather than reading them: watching for news, putting work back,
 * starting a session, handing work between agents and walking through a change.
 */

const NOW = new Date('2026-09-30T12:00:00.000Z');

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
  const home = await mkdtemp(join(tmpdir(), 'memnox-voice-control-'));
  return {
    home,
    cwd: home,
    agent: 'claude-code',
    env: {},
    now: () => NOW,
    readStatus: async () => ({ mode: 'enforce' }),
    milestonesAt: async (place) =>
      milestonesIn(place)
        .list()
        .catch(() => []),
    brief: async () => null,
    resolveCommand: (agent) => STARTABLE_AGENT[agent],
  };
}

function edit(sessionId: string, target: string, at: string): MemnoxEvent {
  return {
    id: `evt_${sessionId}_${at}`,
    schemaVersion: 1,
    at,
    sessionId,
    agent: 'claude-code',
    actorType: 'agent',
    surface: 'filesystem',
    operation: 'file.edit',
    target,
    class: 'write',
    effect: 'allow',
    mode: 'enforce',
    reason: 'no rule matched',
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

/** A repository a session edited after its milestone, the way a real session leaves one. */
async function workedOn(deps: SessionToolDeps, name = 'memnox-cloud'): Promise<string> {
  const parent = realpathSync(await mkdtemp(join(tmpdir(), 'memnox-voice-repos-')));
  const repo = join(parent, name);
  await mkdir(repo);
  git(repo, 'init', '-q');
  await writeFile(join(repo, 'card.ts'), 'export const card = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'start');
  await milestonesIn(repo).take({
    at: '2026-09-30T11:00:00.000Z',
    sessionId: 'ses_work',
  });
  await writeFile(
    join(repo, 'card.ts'),
    'export const card = 2;\nexport const flat = true;\n',
  );
  await recorded(deps.home, [
    edit('ses_work', join(repo, 'card.ts'), '2026-09-30T11:10:00.000Z'),
  ]);
  await new SessionHosts(deps.home).note({
    sessionId: 'ses_work',
    agent: 'claude-code',
    pid: process.pid,
    app: 'iTerm',
    cwd: repo,
    seenAt: '2026-09-30T11:00:00.000Z',
  });
  return repo;
}

describe('telling the person when something they asked about happens', () => {
  it('speaks once when the turn they were waiting on ends, and never again', async () => {
    const deps = await depsAt();
    await new SessionTurns(deps.home).prompted(
      'ses_work',
      'claude-code',
      '2026-09-30T11:50:00.000Z',
    );
    expect(
      await callOperatorTool(deps, SEAMS, 'watch_for', {
        session: 'ses_work',
        for: 'finished',
        said: 'tell me when it is done',
      }),
    ).toMatchObject({ watching: true, for: 'finished' });
    const watcher = new NoticeWatcher(deps.home, NOW.toISOString());
    expect(await watcher.look('2026-09-30T12:00:30.000Z')).toEqual([]);

    await new SessionTurns(deps.home).ended(
      'ses_work',
      'claude-code',
      '2026-09-30T12:01:00.000Z',
    );
    const told = await watcher.look('2026-09-30T12:01:30.000Z');
    const watched = told.filter((each) => each.notice === 'watched');
    expect(watched).toHaveLength(1);
    expect(watched[0]?.summary).toContain('it finished its turn');
    expect(watched[0]?.summary).toContain('tell me when it is done');
    expect(await new SessionWatches(deps.home).open('2026-09-30T12:02:00.000Z')).toEqual(
      [],
    );
  });

  it('refuses something it cannot watch for, rather than watching for nothing', async () => {
    const deps = await depsAt();
    expect(
      await callOperatorTool(deps, SEAMS, 'watch_for', {
        session: 'ses_work',
        for: 'lunch',
      }),
    ).toMatchObject({ watching: false });
  });

  it('reads test runs from the transcript, passed and failed', () => {
    const lines = [
      {
        type: 'assistant',
        timestamp: '2026-09-30T12:00:00.000Z',
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-09-30T12:00:10.000Z',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: 'Exit code 1\nFAIL',
              is_error: true,
            },
          ],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-09-30T12:01:00.000Z',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 't2',
              name: 'Bash',
              input: { command: 'git status' },
            },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-09-30T12:01:01.000Z',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't2', content: 'clean', is_error: false },
          ],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-09-30T12:02:00.000Z',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 't3',
              name: 'Bash',
              input: { command: 'npx vitest run cart' },
            },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-09-30T12:02:09.000Z',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't3',
              content: 'all passed',
              is_error: false,
            },
          ],
        },
      },
    ];
    expect(testRunsIn(lines.map((each) => JSON.stringify(each)).join('\n'))).toEqual([
      { at: '2026-09-30T12:00:10.000Z', command: 'pnpm test', passed: false },
      { at: '2026-09-30T12:02:09.000Z', command: 'npx vitest run cart', passed: true },
    ]);
  });
});

describe('putting back what a session broke', () => {
  it('proposes the rewind with what goes back, and moves nothing until it is confirmed', async () => {
    const deps = await depsAt();
    const repo = await workedOn(deps);
    const answer = (await callOperatorTool(deps, SEAMS, 'propose_rewind', {
      session: 'ses_work',
      said: 'that broke it, put it back',
    })) as { proposed: string; repository: string; files: number };
    expect(answer).toMatchObject({ repository: 'memnox-cloud', files: 1 });
    const proposal = await new Proposals(deps.home).read(answer.proposed);
    expect(proposal?.change).toMatchObject({
      kind: PROPOSAL_KIND.REWIND,
      repository: repo,
    });
    // Proposed only: the file is still as the session left it.
    expect(await readFile(join(repo, 'card.ts'), 'utf8')).toContain('flat');
  });

  it('puts the files back once Touch ID signs for it, and refuses an unsigned yes', async () => {
    const deps = await depsAt();
    const repo = await workedOn(deps);
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    await new ConfirmKeys(deps.home).register(
      spki.subarray(spki.length - 65).toString('base64'),
      NOW.toISOString(),
    );
    const { proposed } = (await callOperatorTool(deps, SEAMS, 'propose_rewind', {
      session: 'ses_work',
    })) as { proposed: string };
    const at = '2026-09-30T12:00:30.000Z';
    expect(
      await confirmAnswer(deps.home, { subject: proposed, answer: 'confirmed', at }),
    ).toMatchObject({ ok: false });
    expect(await readFile(join(repo, 'card.ts'), 'utf8')).toContain('flat');

    const signature = sign(
      'sha256',
      Buffer.from(confirmationMessage(proposed, 'confirmed')),
      privateKey,
    ).toString('base64');
    expect(
      await confirmAnswer(deps.home, {
        subject: proposed,
        answer: 'confirmed',
        signature,
        at,
      }),
    ).toMatchObject({ ok: true });
    expect(await readFile(join(repo, 'card.ts'), 'utf8')).toBe(
      'export const card = 1;\n',
    );
  });

  it('says there is nothing to put back for a session that took no milestone', async () => {
    const deps = await depsAt();
    expect(
      await callOperatorTool(deps, SEAMS, 'propose_rewind', { session: 'ses_nothing' }),
    ).toMatchObject({ proposed: false });
  });
});

describe('starting a session out loud', () => {
  it('finds the repository by the name said, reads it back, and starts it only once', async () => {
    const deps = await depsAt();
    const repo = await workedOn(deps, 'memnox-runtime');
    const sibling = join(repo, '..', 'memnox-cloud');
    await mkdir(sibling);
    git(sibling, 'init', '-q');
    const proposed = (await callOperatorTool(deps, SEAMS, 'propose_start', {
      repository: 'memnox cloud',
      task: "fix the failing auth test, it's flaky",
    })) as { start: string; repository: string };
    expect(proposed.repository).toBe('memnox-cloud');
    const typed: SessionToolDeps = {
      ...deps,
      delivered: async () => ({ outcome: 'typed', at: NOW.toISOString() }),
    };
    expect(
      await callOperatorTool(typed, SEAMS, 'start_session', { start: proposed.start }),
    ).toMatchObject({ started: true, repository: 'memnox-cloud' });
    const [request] = await new DisplayRequests(deps.home).open(NOW.toISOString());
    expect(request).toMatchObject({ display: 'launch', cwd: sibling });
    // Quoted whole, so a quote in the task stays words and never ends the command.
    expect(request?.text).toBe(
      `cd '${sibling}' && memnox run -- claude 'fix the failing auth test, it'\\''s flaky'`,
    );
    expect(
      await callOperatorTool(typed, SEAMS, 'start_session', { start: proposed.start }),
    ).toMatchObject({ started: false });
  });

  it('finds a repository no session has opened yet, in the folders code is kept in', async () => {
    const base = await depsAt();
    const deps: SessionToolDeps = { ...base, resolveCommand: () => 'claude' };
    const client = join(deps.home, 'Documents', 'Memnox-saas', 'memnox-client');
    await mkdir(client, { recursive: true });
    git(client, 'init', '-q');
    const proposed = (await callOperatorTool(deps, SEAMS, 'propose_start', {
      repository: 'memnox client',
      task: 'check for uncommitted changes',
    })) as { repository: string };
    expect(proposed.repository).toBe('memnox-client');
  });

  it('starts an agent from where it is installed when the shell cannot find it', async () => {
    const base = await depsAt();
    const repo = await workedOn(base, 'memnox-runtime');
    const codexInChatGpt = '/Applications/ChatGPT.app/Contents/Resources/codex';
    const deps: SessionToolDeps = {
      ...base,
      resolveCommand: (agent) => (agent === 'codex' ? codexInChatGpt : null),
      delivered: async () => ({ outcome: 'typed', at: NOW.toISOString() }),
    };
    const proposed = (await callOperatorTool(deps, SEAMS, 'propose_start', {
      agent: 'codex',
      repository: 'my locks runtime',
      task: 'tell me the git changes',
    })) as { start: string };
    await callOperatorTool(deps, SEAMS, 'start_session', { start: proposed.start });
    const [request] = await new DisplayRequests(deps.home).open(NOW.toISOString());
    expect(request?.text).toBe(
      `cd '${repo}' && memnox run -- '${codexInChatGpt}' 'tell me the git changes'`,
    );
  });

  it('starts only the agents it knows the command for', async () => {
    const deps = await depsAt();
    expect(
      await callOperatorTool(deps, SEAMS, 'propose_start', {
        agent: 'rm -rf',
        repository: 'anything',
        task: 'x',
      }),
    ).toMatchObject({ proposed: false });
  });

  it('matches a spoken name to a repository, exact before partial', () => {
    const known = ['/a/memnox-cloud', '/a/memnox-client', '/a/memnox'];
    expect(repositoryNamed('Memnox Client', known)).toBe('/a/memnox-client');
    expect(repositoryNamed('memnox', known)).toBe('/a/memnox');
    expect(repositoryNamed('payments', known)).toBeNull();
  });

  it('still finds the repository when the recognizer mishears its name', () => {
    const known = ['/a/memnox-runtime', '/a/memnox-cloud', '/a/memnox-macos'];
    expect(repositoryNamed('my locks runtime', known)).toBe('/a/memnox-runtime');
    expect(repositoryNamed('mem knocks cloud', known)).toBe('/a/memnox-cloud');
    expect(repositoryNamed('memno macos', known)).toBe('/a/memnox-macos');
  });

  it('refuses an agent whose command is not installed, and names the ones that are', async () => {
    const deps: SessionToolDeps = {
      ...(await depsAt()),
      resolveCommand: (agent) => (agent === 'claude-code' ? 'claude' : null),
    };
    expect(
      await callOperatorTool(deps, SEAMS, 'propose_start', {
        agent: 'codex',
        repository: 'anything',
        task: 'tell me the git changes',
      }),
    ).toMatchObject({ proposed: false, missing: 'codex', installed: ['claude-code'] });
  });
});

describe('handing work from one agent to another', () => {
  it('adds the files the other session changed to the instruction', async () => {
    const deps = await depsAt();
    const repo = await workedOn(deps);
    const answer = (await callOperatorTool(deps, SEAMS, 'propose_instruction', {
      session: 'ses_codex',
      message: 'review what Claude just changed',
      about: 'ses_work',
    })) as { instruction: string; readBack: string };
    expect(answer.readBack).toBe('review what Claude just changed');
    const taken = await new SpokenInstructions(deps.home).take(
      answer.instruction,
      NOW.toISOString(),
    );
    expect(taken?.message).toBe(
      `review what Claude just changed The files to look at in ${repo} are: card.ts.`,
    );
  });
});

describe('walking through a change', () => {
  it('puts up one page per file the session changed, with its changed lines', async () => {
    const deps = await depsAt();
    await workedOn(deps);
    expect(
      await callOperatorTool(deps, SEAMS, 'walk_through', {
        session: 'ses_work',
        pages: [
          { path: 'card.ts', note: 'The card now stays flat.' },
          { path: 'nowhere.ts', note: 'Never changed.' },
        ],
      }),
    ).toMatchObject({ shown: true, pages: ['card.ts'] });
    const [request] = await new DisplayRequests(deps.home).open(NOW.toISOString());
    expect(request).toMatchObject({ display: 'walk' });
    expect(request?.pages?.[0]).toMatchObject({
      path: 'card.ts',
      note: 'The card now stays flat.',
    });
    expect(request?.pages?.[0]?.lines).toContain('+export const flat = true;');
    expect(basename(request?.pages?.[0]?.path ?? '')).toBe('card.ts');
  });
});

describe('remembering which session they meant', () => {
  it('notes the session it opened, so the next "it" is that one', async () => {
    const deps = await depsAt();
    await workedOn(deps);
    await callOperatorTool(deps, SEAMS, 'show', { session: 'ses_work', display: 'open' });
    expect(await new VoiceFocusStore(deps.home).read()).toMatchObject({
      sessionId: 'ses_work',
      why: 'opened',
    });
  });

  it('names a session by the agent its rows name, not a child recorded as an agent', async () => {
    const deps = await depsAt();
    await recorded(deps.home, [
      { ...edit('ses_cursor', '/r/a.ts', '2026-09-30T11:50:00.000Z'), agent: 'an agent' },
      { ...edit('ses_cursor', '/r/b.ts', '2026-09-30T11:51:00.000Z'), agent: 'cursor' },
    ]);
    const rows = (await callOperatorTool(deps, SEAMS, 'sessions', {})) as {
      session: string;
      agent: string;
    }[];
    expect(rows.find((each) => each.session === 'ses_cursor')?.agent).toBe('cursor');
  });
});

describe('showing every agent on the whole screen', () => {
  it('puts each agent up with what it reaches and its sessions, counted from the scan', async () => {
    const deps = await depsAt();
    await new SessionTurns(deps.home).prompted(
      'ses_live',
      'codex',
      '2026-09-30T11:59:00.000Z',
    );
    // Only the two fields the screen reads; the rest of a report is not what this is about.
    const report = {
      agents: [
        { id: 'agt_claude-code', kind: 'claude-code' },
        { id: 'agt_codex-cli', kind: 'codex-cli' },
      ],
      surfaces: [
        { agentId: 'agt_claude-code', kind: 'shell' },
        { agentId: 'agt_claude-code', kind: 'mcp', servers: [{}, {}, {}] },
        { agentId: 'agt_codex-cli', kind: 'filesystem' },
      ],
    } as unknown as DiscoveryReport;
    expect(await showAgentsTool(deps, {}, async () => report)).toMatchObject({
      shown: true,
      agents: [
        { name: 'Claude Code', servers: 3, reaches: ['shell'], working: 0 },
        { servers: 0, reaches: ['filesystem'], working: 1 },
      ],
    });
    const [request] = await new DisplayRequests(deps.home).open(NOW.toISOString());
    expect(request).toMatchObject({ display: 'agents' });
    expect(request?.agents?.map((each) => each.kind)).toEqual([
      'claude-code',
      'codex-cli',
    ]);
  });

  it('says so when the scan finds nothing, rather than an empty screen', async () => {
    const deps = await depsAt();
    const empty = { agents: [], surfaces: [] } as unknown as DiscoveryReport;
    expect(await showAgentsTool(deps, {}, async () => empty)).toMatchObject({
      shown: false,
    });
  });
});
