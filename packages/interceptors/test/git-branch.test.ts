import { describe, expect, it } from 'vitest';
import { branchResource, pushedBranches, type Checkout } from '../src/git-branch';

const on = (
  branch: string | null,
  url: string | null = 'git@github.com:Acme/API.git',
): Checkout => ({
  currentBranch: () => branch,
  remoteUrl: () => url,
});

describe('the branches a push writes', () => {
  it('reads the current branch where the line names none', () => {
    expect(pushedBranches(['push'], on('feature/billing'))).toEqual([
      'github:acme/api#branch/feature/billing',
    ]);
  });

  it('reads the destination of each refspec, forced or deleted', () => {
    expect(
      pushedBranches(
        ['push', '-u', 'origin', 'HEAD:main', '+wip:refs/heads/scratch', ':old'],
        on('local'),
      ),
    ).toEqual([
      'github:acme/api#branch/main',
      'github:acme/api#branch/scratch',
      'github:acme/api#branch/old',
    ]);
  });

  it('looks past what git reads for itself and the options that take a value', () => {
    expect(
      pushedBranches(['-C', 'api', 'push', '-o', 'ci.skip', 'origin', 'main'], on(null)),
    ).toEqual(['github:acme/api#branch/main']);
  });

  it('claims nothing for a tag, every ref at once, a detached head, or no remote', () => {
    expect(pushedBranches(['push', 'origin', 'refs/tags/v1'], on('main'))).toEqual([]);
    expect(pushedBranches(['push', '--tags'], on('main'))).toEqual([]);
    expect(pushedBranches(['push', '--all'], on('main'))).toEqual([]);
    expect(pushedBranches(['push'], on(null))).toEqual([]);
    expect(pushedBranches(['push'], on('main', null))).toEqual([]);
  });

  it('is not a push', () => {
    expect(pushedBranches(['pull', 'origin', 'main'], on('main'))).toEqual([]);
  });
});

describe('a branch on any remote', () => {
  it('names a GitHub branch as a pushing tool call would', () => {
    expect(branchResource('https://github.com/acme/api.git', 'main')).toBe(
      'github:acme/api#branch/main',
    );
  });

  it('names a branch anywhere else by host and path', () => {
    expect(branchResource('git@gitlab.example.com:team/api.git', 'main')).toBe(
      'git:gitlab.example.com/team/api#branch/main',
    );
    expect(branchResource('https://git.example.com/team/api', 'Main')).toBe(
      'git:git.example.com/team/api#branch/main',
    );
  });
});
