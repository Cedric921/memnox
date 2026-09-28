import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CODE_FINGERPRINT_FILE,
  FINGERPRINT_PROMPT,
  parseCodeFingerprint,
} from '@memnox/core';

import { answerText } from '../src/session-tools/bounded';
import { fingerprintTool } from '../src/session-tools/fingerprint-tool';
import type { SessionToolDeps } from '../src/session-tools/read-tools';

/* The first agent in a repository records how its code is written, and every agent after
   it is held to that. It needs nobody, because it can only add what agents are held to. */

const PROPOSED = `
language:
  primary: go
naming:
  files: snake_case
enforce:
  - name: no-fmt-println
    files: ["internal/**"]
    forbid: ["*fmt.println(*"]
    reason: log through the logger
    instead: call log.Info
  - name: no-panic
    files: ["internal/**"]
    forbid: ["*panic(*"]
    reason: return errors rather than panicking
`;

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'memnox-fingerprint-tool-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  await mkdir(join(root, 'internal'), { recursive: true });
  // The code already panics once, so a check forbidding it does not describe this code.
  await writeFile(
    join(root, 'internal', 'serve.go'),
    'func Serve() {\n\tpanic("todo")\n}\n',
  );
  git('add', '.');
  return root;
}

function depsIn(cwd: string): SessionToolDeps {
  return {
    home: cwd,
    cwd,
    agent: 'claude-code',
    env: {},
    now: () => new Date('2026-09-28T10:00:00.000Z'),
    readStatus: async () => ({}),
    milestonesAt: async () => [],
    brief: async () => null,
  };
}

const recorded = async (root: string) =>
  parseCodeFingerprint(await readFile(join(root, CODE_FINGERPRINT_FILE), 'utf8'));

describe('the fingerprint tool', () => {
  it('says what to write when called without it, whole, as the agent reads it', async () => {
    const answer = JSON.parse(
      answerText(await fingerprintTool(depsIn(await repository()), {})),
    ) as { said: string };

    expect(answer.said).toBe(FINGERPRINT_PROMPT);
  });

  it('records it, dropping a check the code already breaks and saying where', async () => {
    const root = await repository();

    const answer = (await fingerprintTool(depsIn(root), { yaml: PROPOSED })) as {
      recorded: string;
      enforced: string[];
      dropped: string[];
      next: string;
    };

    expect(answer.recorded).toBe(CODE_FINGERPRINT_FILE);
    expect(answer.enforced).toEqual(['no-fmt-println: log through the logger']);
    expect(answer.dropped[0]).toContain('no-panic');
    expect(answer.dropped[0]).toContain('internal/serve.go');
    expect(answer.next).toContain('Tell the person running you');
    const file = await recorded(root);
    expect(file.checks.map((check) => check.name)).toEqual(['no-fmt-println']);
    expect(file.guidance).toContain('naming.files: snake_case');
  });

  it('tests a repository nobody has committed to yet against its untracked code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memnox-fingerprint-untracked-'));
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    await mkdir(join(root, 'internal'), { recursive: true });
    await writeFile(
      join(root, 'internal', 'serve.go'),
      'func Serve() {\n\tpanic("todo")\n}\n',
    );

    const answer = (await fingerprintTool(depsIn(root), { yaml: PROPOSED })) as {
      dropped: string[];
    };

    expect(answer.dropped[0]).toContain('internal/serve.go');
  });

  it('never takes a vendored directory for the code, even where nothing ignores it', async () => {
    const root = await repository();
    const vendored = join(root, 'internal', 'node_modules', 'lib');
    await mkdir(vendored, { recursive: true });
    await writeFile(join(vendored, 'print.go'), 'fmt.Println("vendored")\n');

    const answer = (await fingerprintTool(depsIn(root), { yaml: PROPOSED })) as {
      enforced: string[];
    };

    expect(answer.enforced).toEqual(['no-fmt-println: log through the logger']);
  });

  it('drops a check whose files name nothing the repository has', async () => {
    const root = await repository();
    const guessed = `${PROPOSED}  - name: no-sleep
    files: ["cmd/**"]
    forbid: ["*time.sleep(*"]
    reason: no sleeping in commands
`;

    const answer = (await fingerprintTool(depsIn(root), { yaml: guessed })) as {
      enforced: string[];
      dropped: string[];
    };

    expect(answer.enforced).toEqual(['no-fmt-println: log through the logger']);
    expect(answer.dropped).toContainEqual(
      expect.stringContaining('no-sleep: its files name nothing'),
    );
    expect((await recorded(root)).checks.map((check) => check.name)).toEqual([
      'no-fmt-println',
    ]);
  });

  it('records nothing in a repository with no code of its own, since it could only guess', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memnox-fingerprint-empty-'));
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    await mkdir(join(root, 'node_modules', 'lib'), { recursive: true });
    await writeFile(
      join(root, 'node_modules', 'lib', 'index.js'),
      'module.exports = 1;\n',
    );

    const answer = (await fingerprintTool(depsIn(root), { yaml: PROPOSED })) as {
      recorded: boolean;
      said: string;
    };

    expect(answer.recorded).toBe(false);
    expect(answer.said).toContain('no code of its own');
    await expect(readFile(join(root, CODE_FINGERPRINT_FILE))).rejects.toThrow();
  });

  it("never changes a repository's fingerprint once it states one, so none is loosened", async () => {
    const root = await repository();
    await fingerprintTool(depsIn(root), { yaml: PROPOSED });

    const again = (await fingerprintTool(depsIn(root), {
      yaml: 'naming:\n  files: camelCase\n',
    })) as { said: string };

    expect(again.said).toContain('only a person changes them');
    expect((await recorded(root)).guidance).toContain('naming.files: snake_case');
  });

  it('records nothing for an answer that states no convention', async () => {
    const root = await repository();

    const answer = (await fingerprintTool(depsIn(root), {
      yaml: 'I could not read the code.',
    })) as { recorded: boolean };

    expect(answer.recorded).toBe(false);
    await expect(readFile(join(root, CODE_FINGERPRINT_FILE))).rejects.toThrow();
  });

  it('records nothing outside a repository', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'memnox-not-a-repo-'));

    const answer = (await fingerprintTool(depsIn(outside), { yaml: PROPOSED })) as {
      said: string;
    };

    expect(answer.said).toContain('not a repository');
  });
});
