/**
 * The first agent in a repository records how its code is written, for every agent after it.
 * A first fingerprint only, never a change to one, so it can only tighten and needs no person.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  checksBreakingExisting,
  CODE_FINGERPRINT_FILE,
  FINGERPRINT_PROMPT,
  proposalFrom,
  saysSomething,
  withoutChecks,
  type ExistingFile,
} from '@memnox/core';
import { repositoryRootOf } from '@memnox/interceptors';

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
  if (yaml === undefined) return { said: FINGERPRINT_PROMPT };
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
  const broken = checksBreakingExisting(
    proposal.fingerprint,
    root,
    await trackedFiles(root),
  );
  const dropped = new Set(broken.map((each) => each.name));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, withoutChecks(proposal.yaml, dropped), 'utf8');
  return {
    recorded: CODE_FINGERPRINT_FILE,
    told: `${proposal.fingerprint.guidance.length} convention(s), said to every agent at the start of a session`,
    enforced: proposal.fingerprint.checks
      .filter((check) => !dropped.has(check.name))
      .map((check) => `${check.name}: ${check.reason}`),
    ...(broken.length === 0
      ? {}
      : {
          dropped: broken.map(
            (each) =>
              `${each.name}: the code already has ${each.lines} such line(s), first in ${each.first}, so it does not describe this repository`,
          ),
        }),
    ...(proposal.fingerprint.issues.length === 0
      ? {}
      : { skipped: proposal.fingerprint.issues }),
    next: TELL_PERSON,
  };
}

/** What git tracks, so nothing ignored, built or vendored is taken for the team's code. */
async function trackedFiles(root: string): Promise<ExistingFile[]> {
  const listed = await new Promise<string>((settle) => {
    execFile(
      'git',
      ['ls-files', '-z'],
      { cwd: root, maxBuffer: MOST_LISTING_BYTES },
      // No listing tests nothing and keeps every check: the gate still reads only what is added.
      (error, out) => settle(error === null ? out : ''),
    );
  });
  const files: ExistingFile[] = [];
  for (const relative of listed.split('\0').filter(Boolean).slice(0, MOST_FILES_READ)) {
    const path = join(root, relative);
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
