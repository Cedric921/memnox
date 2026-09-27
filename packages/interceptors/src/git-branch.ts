import { execFileSync } from 'node:child_process';
import { actionResource, ownProcessEnv, repositoryIdentity } from '@memnox/core';

/**
 * The remote branches a `git push` line writes, named the way a GitHub tool call that
 * pushes to one would be, so two agents pushing to one branch from two machines meet.
 */

/** Options git takes before its subcommand, each with a value in the next word. */
const GLOBAL_VALUE_OPTIONS: readonly string[] = [
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
];

/** `git push` options whose value is the next word. */
const PUSH_VALUE_OPTIONS: readonly string[] = [
  '-o',
  '--push-option',
  '--receive-pack',
  '--exec',
  '--repo',
];

/** Pushes that name no one branch, so there is nothing to claim. */
const EVERY_REF: readonly string[] = ['--all', '--mirror', '--tags'];

const HEADS = 'refs/heads/';

/** Where the answers about this checkout come from, a seam so a test needs no repository. */
export interface Checkout {
  currentBranch(): string | null;
  remoteUrl(remote: string): string | null;
}

/**
 * The branch resources a push writes, or an empty list for a line that is not a push or
 * names no branch. A tag is not claimed: two agents do not work on a tag.
 */
export function pushedBranches(
  args: readonly string[],
  checkout: Checkout = localCheckout,
): string[] {
  const at = subcommandAt(args);
  if (args[at] !== 'push') return [];
  const words = args.slice(at + 1);
  if (words.some((word) => EVERY_REF.includes(word))) return [];

  const positional: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (PUSH_VALUE_OPTIONS.includes(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith('-')) continue;
    positional.push(word);
  }
  const [remote = 'origin', ...refspecs] = positional;
  const url = checkout.remoteUrl(remote);
  if (url === null) return [];

  const branches =
    refspecs.length === 0
      ? [checkout.currentBranch()]
      : refspecs.map((refspec) => destinationOf(refspec, checkout));
  return [
    ...new Set(
      branches
        .filter((branch): branch is string => branch !== null && branch !== '')
        .map((branch) => branchResource(url, branch))
        .filter((resource): resource is string => resource !== undefined),
    ),
  ];
}

/**
 * The branch a refspec writes on the remote: `a:b` writes `b`, `:b` deletes `b`, `a`
 * writes `a`, and a `+` only forces it. Null for a tag or any ref that is not a branch.
 */
function destinationOf(refspec: string, checkout: Checkout): string | null {
  const spec = refspec.startsWith('+') ? refspec.slice(1) : refspec;
  const colon = spec.lastIndexOf(':');
  const target = colon === -1 ? spec : spec.slice(colon + 1);
  if (target === 'HEAD') return checkout.currentBranch();
  if (target.startsWith(HEADS)) return target.slice(HEADS.length);
  return target.startsWith('refs/') ? null : target;
}

/** A branch on a remote, as a ref every agent pushing there produces alike. */
export function branchResource(url: string, branch: string): string | undefined {
  const github = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  if (github !== null) {
    const [, owner, repo] = github;
    if (owner === undefined || repo === undefined) return undefined;
    return actionResource('github', { owner, repo, branch });
  }
  const host = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/i.exec(url);
  if (host === null) return undefined;
  const [, name, path] = host;
  if (name === undefined || path === undefined) return undefined;
  return `git:${name}/${path}#branch/${branch}`.toLowerCase();
}

/** Where the subcommand sits, past the options git reads for itself. */
function subcommandAt(args: readonly string[]): number {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? '';
    if (GLOBAL_VALUE_OPTIONS.includes(word)) {
      index += 1;
      continue;
    }
    if (!word.startsWith('-')) return index;
  }
  return args.length;
}

/** Milliseconds. Asked only for a push, which is about to talk to a network anyway. */
const GIT_TIMEOUT_MS = 2_000;

function git(args: readonly string[]): string | null {
  try {
    const out = execFileSync('git', [...args], {
      // The real git, or asking runs the git interceptor inside this one.
      env: ownProcessEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    return out === '' ? null : out;
  } catch {
    // Not a checkout, a detached head, or no such remote: nothing to name.
    return null;
  }
}

/**
 * The repository a checkout is, by its `origin`, so a lease on another machine meets it
 * only in the same project. Undefined where there is no remote, which matches any.
 */
export function remoteIdentityOf(root: string): string | undefined {
  return repositoryIdentity(git(['-C', root, 'remote', 'get-url', 'origin']));
}

const localCheckout: Checkout = {
  currentBranch: () => git(['symbolic-ref', '--short', 'HEAD']),
  remoteUrl: (remote) => git(['remote', 'get-url', remote]),
};
