import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEASE_OUTCOME, LeaseRegistry } from '../src/coordination/lease-store';
import {
  repositoryIdentity,
  sameRepository,
} from '../src/coordination/repository-identity';

describe('which repository a checkout is', () => {
  it('names one project the same over ssh, https, with or without .git', () => {
    for (const url of [
      'git@github.com:Acme/API.git',
      'https://github.com/acme/api',
      'https://token@github.com/acme/api.git/',
      'ssh://git@github.com:22/acme/api.git',
    ]) {
      expect(repositoryIdentity(url), url).toBe('github.com/acme/api');
    }
    expect(repositoryIdentity('git@gitlab.example.com:team/sub/api.git')).toBe(
      'gitlab.example.com/team/sub/api',
    );
  });

  it('names nothing for what is not a remote, which matches any repository', () => {
    expect(repositoryIdentity('/srv/git/api.git')).toBeUndefined();
    expect(repositoryIdentity(null)).toBeUndefined();
    expect(sameRepository(undefined, 'github.com/acme/api')).toBe(true);
    expect(sameRepository('github.com/acme/web', 'github.com/acme/api')).toBe(false);
  });
});

describe('two repositories on one machine', () => {
  const holder = (sessionId: string) => ({ agent: 'claude-code', sessionId, pid: 1_000 });
  const NOW = '2026-09-27T10:00:00.000Z';
  const main = { lines: [{ from: 3, to: 3 }], symbols: ['main'] };

  it('never meet on the same path, and one repository still does', async () => {
    const leases = new LeaseRegistry(
      await mkdtemp(join(tmpdir(), 'memnox-repos-')),
      () => true,
    );
    await leases.take(
      {
        path: 'src/index.ts',
        holder: holder('s1'),
        repository: '/work/api',
        region: main,
      },
      NOW,
    );
    const other = await leases.take(
      {
        path: 'src/index.ts',
        holder: holder('s2'),
        repository: '/work/web',
        region: main,
      },
      NOW,
    );
    const same = await leases.take(
      {
        path: 'src/index.ts',
        holder: holder('s3'),
        repository: '/work/api',
        region: main,
      },
      NOW,
    );
    expect(other.outcome).toBe(LEASE_OUTCOME.TAKEN);
    expect(same.outcome).toBe(LEASE_OUTCOME.HELD_BY_ANOTHER);
  });
});
