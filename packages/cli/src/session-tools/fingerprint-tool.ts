/**
 * The first agent in a repository records how its code is written, for every agent after it.
 * A first fingerprint only, never a change to one, so it can only tighten and needs no person.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  checksBreakingExisting,
  checksCoveringNothing,
  CODE_FINGERPRINT_FILE,
  FINGERPRINT_PROMPT,
  pathsChecked,
  proposalFrom,
  saysSomething,
  withoutChecks,
  type BrokenCheck,
  type CodeFingerprint,
  type ExistingFile,
} from '@memnox/core';
import { repositoryRootOf } from '@memnox/interceptors';

import { OwnText } from './bounded';
import { textArg, type SessionToolDeps, type ToolArgs } from './read-tools';

/** Files a proposal is tested against, so a monorepo cannot hold the agent for minutes. */
const MOST_FILES_READ = 5_000;

/** A file larger than this is generated or vendored, and no convention is read out of it. */
const MOST_FILE_BYTES = 512 * 1024;

/** Room for the names of every tracked file in a large repository. */
const MOST_LISTING_BYTES = 64 * 1024 * 1024;

const TELL_PERSON = `Tell the person running you that this repository's conventions are now in ${CODE_FINGERPRINT_FILE}, for the team to review and commit.`;

export async function fingerprintTool(
  deps: SessionToolDeps,
  args: ToolArgs,
): Promise<unknown> {
  const root = repositoryRootOf(deps.cwd);
  if (root === null) {
    return { said: 'This is not a repository, so there is nothing to record.' };
  }
  const file = join(root, CODE_FINGERPRINT_FILE);
  if (await exists(file)) {
    return {
      said: `This repository already states its conventions in ${CODE_FINGERPRINT_FILE}, and only a person changes them. Follow it.`,
    };
  }
  const yaml = textArg(args, 'yaml');
  if (yaml === undefined) return { said: new OwnText(FINGERPRINT_PROMPT) };
  return record(root, file, yaml);
}

/** Tested against the code it describes, written without what that code already breaks. */
async function record(root: string, file: string, yaml: string): Promise<unknown> {
  const proposal = proposalFrom(yaml);
  if (!saysSomething(proposal.fingerprint)) {
    return {
      recorded: false,
      said: 'That states no convention, so nothing was recorded.',
      issues: proposal.fingerprint.issues,
    };
  }
  const paths = await ownPaths(root);
  if (paths.length === 0) {
    return {
      recorded: false,
      said: 'This repository has no code of its own yet, so a fingerprint could only be a guess and nothing was recorded.',
    };
  }
  const { fingerprint } = proposal;
  const checked = pathsChecked(fingerprint, root, paths);
  const tested: Tested = {
    fingerprint,
    empty: checksCoveringNothing(fingerprint, root, paths),
    broken: checksBreakingExisting(fingerprint, root, await readFiles(checked)),
    checked: checked.length,
  };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, withoutChecks(proposal.yaml, droppedOf(tested)), 'utf8');
  return recordedAnswer(tested);
}

/** A proposal tested against the code, and what the test found. */
interface Tested {
  fingerprint: CodeFingerprint;
  /** Checks whose files name nothing the repository has. */
  empty: string[];
  broken: BrokenCheck[];
  /** How many files some check covers, read or not. */
  checked: number;
}

function droppedOf(tested: Tested): Set<string> {
  return new Set([...tested.empty, ...tested.broken.map((each) => each.name)]);
}

/** What the agent is told was recorded, dropped and left untested, so it can say so. */
function recordedAnswer(tested: Tested): unknown {
  const { fingerprint, empty, broken, checked } = tested;
  const dropped = droppedOf(tested);
  const reasons = [
    ...empty.map(
      (name) =>
        `${name}: its files name nothing this repository has, so it describes code that is not here`,
    ),
    ...broken.map(
      (each) =>
        `${each.name}: the code already has ${each.lines} such line(s), first in ${each.first}, so it does not describe this repository`,
    ),
  ];
  return {
    recorded: CODE_FINGERPRINT_FILE,
    told: `${fingerprint.guidance.length} convention(s), said to every agent at the start of a session`,
    enforced: fingerprint.checks
      .filter((check) => !dropped.has(check.name))
      .map((check) => `${check.name}: ${check.reason}`),
    ...(reasons.length === 0 ? {} : { dropped: reasons }),
    ...(checked <= MOST_FILES_READ
      ? {}
      : {
          untested: `${checked - MOST_FILES_READ} of the ${checked} files the checks cover were not read, so a kept check may still match code there`,
        }),
    ...(fingerprint.issues.length === 0 ? {} : { skipped: fingerprint.issues }),
    next: TELL_PERSON,
  };
}

/** Directories that hold somebody else's code even where no `.gitignore` says so. */
const VENDORED = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', '.venv']);

/**
 * What git tracks and what it would track, since a repository nobody has committed to yet is
 * all untracked; ignored and vendored files are never taken for the team's code.
 */
async function ownPaths(root: string): Promise<string[]> {
  const listed = await new Promise<string>((settle) => {
    execFile(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, maxBuffer: MOST_LISTING_BYTES },
      // No listing is no code to describe, which is said rather than guessed past.
      (error, out) => settle(error === null ? out : ''),
    );
  });
  return listed
    .split('\0')
    .filter(Boolean)
    .filter((relative) => !relative.split('/').some((part) => VENDORED.has(part)))
    .filter((relative) => relative !== CODE_FINGERPRINT_FILE)
    .map((relative) => join(root, relative));
}

async function readFiles(paths: readonly string[]): Promise<ExistingFile[]> {
  const files: ExistingFile[] = [];
  for (const path of paths.slice(0, MOST_FILES_READ)) {
    const lines = await linesOf(path);
    if (lines !== null) files.push({ path, lines });
  }
  return files;
}

async function linesOf(path: string): Promise<string[] | null> {
  let content: Buffer;
  try {
    content = await readFile(path);
  } catch {
    // Deleted since git listed it, or a submodule: nothing to test.
    return null;
  }
  // Binary or generated, which no convention about written code describes.
  if (content.length > MOST_FILE_BYTES || content.includes(0)) return null;
  return content.toString('utf8').split('\n');
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    // Absent is the ordinary case: the repository states no fingerprint yet.
    return false;
  }
}
