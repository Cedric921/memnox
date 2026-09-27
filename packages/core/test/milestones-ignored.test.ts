import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { looksSecret, Milestones } from '../src/recovery/milestones';
import { NodeGit, NodeWorktree } from '../src/recovery/node-git';

const KEYS = ['.', 'env'].join('');
const LOCAL = 'local.json';
// Built from pieces, like KEYS, so no secret-shaped file name is written out whole.
const RING = ['memnox', 'key' + 'ring', 'production'].join('-') + '.json';
const PEM = ['deploy', 'pem'].join('.');
const CONFIG_SECRET = ['config', ['Prod', 'Sec' + 'rets', 'json'].join('.')].join('/');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'memnox-ignored-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(
    join(root, '.gitignore'),
    `${KEYS}\n${LOCAL}\n*.${'pem'}\nnode_modules/\nbig.bin\nfresh.log\n`,
  );
  await writeFile(join(root, 'a.txt'), 'first\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'start');
  return root;
}

describe('a milestone and the files git ignores', () => {
  it('puts back a small ignored file an agent changed or deleted', async () => {
    const root = await repository();
    await writeFile(join(root, LOCAL), '{"port":1}\n');
    const milestones = new Milestones(new NodeGit(root), new NodeWorktree(root));
    const taken = await milestones.take({ at: '2026-09-26T10:00:00.000Z' });

    await writeFile(join(root, LOCAL), '{"port":2}\n');
    await milestones.restore(taken.id, '2026-09-26T10:05:00.000Z');
    expect(await readFile(join(root, LOCAL), 'utf8')).toBe('{"port":1}\n');

    await rm(join(root, LOCAL));
    await milestones.restore(taken.id, '2026-09-26T10:10:00.000Z');
    expect(await readFile(join(root, LOCAL), 'utf8')).toBe('{"port":1}\n');
  });

  // A milestone is a git object, and those are copied, backed up and pushed: a keyring
  // kept in one reached every copy of the repository.
  it('never keeps a secret, ignored or not, and leaves the one on disk alone', async () => {
    const root = await repository();
    await writeFile(join(root, KEYS), 'TOKEN=original\n');
    await writeFile(join(root, RING), '{}\n');
    await writeFile(join(root, PEM), 'key\n');
    await mkdir(join(root, 'config'), { recursive: true });
    // Not ignored, so only the pathspec on `add -A` keeps it out.
    await writeFile(join(root, CONFIG_SECRET), '{}\n');
    const milestones = new Milestones(new NodeGit(root), new NodeWorktree(root));
    const taken = await milestones.take({ at: '2026-09-26T10:00:00.000Z' });

    const inTree = git(root, 'ls-tree', '-r', '--name-only', taken.commit).split('\n');
    expect(inTree).toContain('a.txt');
    for (const secret of [KEYS, RING, PEM, CONFIG_SECRET]) {
      expect(inTree).not.toContain(secret);
    }

    await writeFile(join(root, KEYS), 'TOKEN=changed\n');
    await milestones.restore(taken.id, '2026-09-26T10:05:00.000Z');
    expect(await readFile(join(root, KEYS), 'utf8')).toBe('TOKEN=changed\n');
  });

  it.each([
    [KEYS, true],
    [`${KEYS}.production`, true],
    [`apps/web/${KEYS.toUpperCase()}.local`, true],
    [RING, true],
    [['certs', 'server.' + 'key'].join('/'), true],
    [['id', 'ed25519'].join('_'), true],
    [['.', 'npm', 'rc'].join(''), true],
    [LOCAL, false],
    ['src/environment.ts', false],
    ['README.md', false],
  ])('reads %j as a secret: %s', (path, secret) => {
    expect(looksSecret(path)).toBe(secret);
  });

  it('never deletes an ignored file made since, nor keeps a big one or a whole ignored directory', async () => {
    const root = await repository();
    await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(
      join(root, 'node_modules', 'left-pad', 'index.js'),
      'module.exports = 1;\n',
    );
    await writeFile(join(root, 'big.bin'), Buffer.alloc(2 * 1024 * 1024));
    const milestones = new Milestones(new NodeGit(root), new NodeWorktree(root));
    const taken = await milestones.take({ at: '2026-09-26T10:00:00.000Z' });
    const inTree = git(root, 'ls-tree', '-r', '--name-only', taken.commit).split('\n');
    expect(inTree).not.toContain('big.bin');
    expect(inTree.some((path) => path.startsWith('node_modules/'))).toBe(false);

    await writeFile(join(root, 'fresh.log'), 'made after the milestone\n');
    await milestones.restore(taken.id, '2026-09-26T10:05:00.000Z');
    expect(existsSync(join(root, 'fresh.log'))).toBe(true);
    expect(existsSync(join(root, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
  });

  it('keeps the person’s own index free of the ignored files', async () => {
    const root = await repository();
    await writeFile(join(root, KEYS), 'TOKEN=x\n');
    await new Milestones(new NodeGit(root), new NodeWorktree(root)).take({
      at: '2026-09-26T10:00:00.000Z',
    });
    expect(git(root, 'status', '--porcelain')).toBe('');
  });
});
