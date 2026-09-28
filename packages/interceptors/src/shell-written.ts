/**
 * What a shell command wrote, read after it ran, since `perl -pi` shows nothing beforehand:
 * the tree kept before is compared after, and a forbidden line it added is told to put right.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  checksBreakingExisting,
  DECISION_EFFECT,
  JsonRecordDir,
  MEMNOX_HOME,
  ownProcessEnv,
  readCodeFingerprint,
  type BrokenCheck,
  type CodeFingerprint,
  type ExistingFile,
} from '@memnox/core';

import { EDIT_HOST } from './agent-edits';
import type { EditHookContext } from './edit-claims';
import { fieldsOf } from './hook-payload';
import { repositoryRootOf } from './seam-runtime';
import type { ToolAnswer } from './tool-hook';

/** The tree a command started from, kept until the host says the command returned. */
interface KeptTree {
  root: string;
  tree: string;
}

const KEPT_DIR = 'shell-trees';

/** Past this, a diff is a generated or vendored rewrite, and no convention is read from it. */
const MOST_DIFF_BYTES = 16 * 1024 * 1024;

/** Before an allowed command runs where a fingerprint enforces something: its tree, kept. */
export async function keepBeforeShell(
  payload: unknown,
  ruled: ToolAnswer,
  context: EditHookContext,
): Promise<void> {
  const { call, ruling } = ruled;
  if (call.shell === undefined || call.host !== EDIT_HOST.PRE_TOOL_USE) return;
  if (ruling.effect !== DECISION_EFFECT.ALLOW) return;
  const id = toolUseOf(payload);
  const root = repositoryRootOf(call.cwd ?? context.cwd);
  if (id === null || root === null || !(await enforces(root))) return;
  const tree = treeOf(root, context.home);
  if (tree !== null) await keptFor(context.home).write(id, { root, tree });
}

/** After it returned: what it added that the fingerprint forbids, said to put right, or null. */
export async function brokenByShell(
  payload: unknown,
  context: EditHookContext,
): Promise<string | null> {
  const id = toolUseOf(payload);
  if (id === null) return null;
  const kept = keptFor(context.home);
  const before = await kept.read(id);
  if (before === null) return null;
  await kept.remove(id);
  const fingerprint = await readCodeFingerprint(before.root).catch(() => null);
  if (fingerprint === null || fingerprint.checks.length === 0) return null;
  const after = treeOf(before.root, context.home);
  if (after === null || after === before.tree) return null;
  const added = addedLines(before.root, before.tree, after, context.home);
  const broken = checksBreakingExisting(fingerprint, before.root, added);
  return broken.length === 0 ? null : putRight(broken, fingerprint);
}

async function enforces(root: string): Promise<boolean> {
  const fingerprint = await readCodeFingerprint(root).catch(() => null);
  return fingerprint !== null && fingerprint.checks.length > 0;
}

/**
 * The working tree as git would commit it, written through an index of its own so the
 * person's index, stash and branches are never touched; ignored files stay out.
 */
function treeOf(root: string, home: string): string | null {
  const scratch = mkdtempSync(join(tmpdir(), 'memnox-tree-'));
  const index = join(scratch, 'index');
  try {
    // Seeded from the real index, so git only rehashes what changed since it was written.
    const real = git(root, home, ['rev-parse', '--git-path', 'index']).trim();
    try {
      copyFileSync(resolve(root, real), index);
    } catch {
      // A repository nothing has been added to yet has no index, and starts from none.
    }
    const env = { GIT_INDEX_FILE: index };
    git(root, home, ['add', '-A', '--', '.'], env);
    return git(root, home, ['write-tree'], env).trim();
  } catch {
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Each file the command changed, with only the lines it added, as a check reads them. */
function addedLines(
  root: string,
  before: string,
  after: string,
  home: string,
): ExistingFile[] {
  const diff = git(root, home, [
    '-c',
    'core.quotepath=off',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '-U0',
    before,
    after,
  ]);
  const files: ExistingFile[] = [];
  let current: { path: string; lines: string[] } | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const named = line.slice(4);
      current = named.startsWith('b/')
        ? { path: join(root, named.slice(2)), lines: [] }
        : null;
      if (current !== null) files.push(current);
      continue;
    }
    if (current !== null && line.startsWith('+')) current.lines.push(line.slice(1));
  }
  return files;
}

function putRight(broken: readonly BrokenCheck[], fingerprint: CodeFingerprint): string {
  const said = broken.map((each) => {
    const check = fingerprint.checks.find((one) => one.name === each.name);
    const instead = check?.instead === undefined ? '' : ` Instead: ${check.instead}.`;
    return `- ${each.name}: ${check?.reason ?? 'a fingerprint check'}. ${each.lines} line(s), first in ${each.first}.${instead}`;
  });
  return [
    "Memnox: that command added lines this repository's code fingerprint forbids. A shell edit is held to the same checks as an edit, so put these right now, before going on:",
    ...said,
  ].join('\n');
}

function git(
  root: string,
  home: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): string {
  return execFileSync('git', args, {
    cwd: root,
    // The real git: the one on PATH is the interceptor, which would rule on this again.
    env: { ...ownProcessEnv(home), ...env },
    encoding: 'utf8',
    maxBuffer: MOST_DIFF_BYTES,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function keptFor(home: string): JsonRecordDir<KeptTree> {
  return new JsonRecordDir(join(home, MEMNOX_HOME, KEPT_DIR));
}

/** The host's id for the call, made safe as a file name, or null where it sends none. */
function toolUseOf(payload: unknown): string | null {
  const id = fieldsOf(payload)?.['tool_use_id'];
  return typeof id === 'string' && id !== '' ? id.replace(/[^\w.-]/g, '_') : null;
}
