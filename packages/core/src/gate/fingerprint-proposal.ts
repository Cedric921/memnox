import { parse, stringify } from 'yaml';

import { matchesAny } from '../policy/pattern-matcher';
import {
  fingerprintPolicies,
  parseCodeFingerprint,
  type CodeFingerprint,
} from './code-fingerprint';

/**
 * What the agent working in a repository is asked, once, so the fingerprint is read out
 * of the code by the model the person already runs and Memnox needs none of its own. Any
 * language and any framework: the agent names what it finds.
 */
export const FINGERPRINT_PROMPT = [
  'Read enough of this repository to see how its code is written, then call the memnox-session "fingerprint" tool with it as `yaml`. Every agent working here after you is held to it.',
  '',
  'Top level sections are yours to name for whatever this codebase uses, in any language or framework: for example language, framework, architecture, naming, functions, errors, async, database, testing, imports, comments. Under each, state what the code actually does, as short values or lists, such as `files: kebab-case` or `avoid: [deeply nested conditionals]`. State only what most of the existing code already follows, never what you would prefer.',
  '',
  'Then add an `enforce` list, only for conventions a single added line can break, which a machine checks on every line an agent writes. Each entry:',
  '  name: a short kebab case id',
  '  files: globs relative to the repository root; a leading ! takes files back out',
  '  forbid: patterns an added line must not match. `*` is the only wildcard and matches anything, matching is case insensitive and covers the whole line, so write `*console.log(*` rather than `console.log(`. No regular expressions.',
  '  reason: the convention, in one line',
  '  instead: what to write instead, in one line',
  'Leave out anything a single line cannot show, such as function length or layering. A check that matches code the repository already has, or whose files name nothing it has, is dropped, so keep each one precise.',
].join('\n');

/** How much of an agent's answer is read, since a fingerprint is a page and never a book. */
export const MOST_PROPOSAL_CHARS = 20_000;

const FENCE = /^```[a-z]*\s*$/i;

/**
 * The fingerprint an agent answered with, read the same way the gate reads the file, so
 * what is recorded is exactly what is enforced. Fences are taken off, since agents add
 * them however they are asked.
 */
export function proposalFrom(answer: string): {
  yaml: string;
  fingerprint: CodeFingerprint;
} {
  const yaml = answer
    .slice(0, MOST_PROPOSAL_CHARS)
    .split('\n')
    .filter((line) => !FENCE.test(line.trim()))
    .join('\n')
    .trim();
  return { yaml: `${yaml}\n`, fingerprint: parseCodeFingerprint(yaml) };
}

/** Whether an answer says anything at all, so an empty or refused one is never written. */
export function saysSomething(fingerprint: CodeFingerprint): boolean {
  return fingerprint.guidance.length > 0 || fingerprint.checks.length > 0;
}

/** One file of the repository as it stands, for testing a check against what is there. */
export interface ExistingFile {
  /** Absolute, as a write is ruled on. */
  path: string;
  lines: readonly string[];
}

/** A check the code already breaks, and where first, so the agent can narrow it. */
export interface BrokenCheck {
  name: string;
  lines: number;
  first: string;
}

/**
 * The checks existing code already breaks. Such a check does not describe the repository,
 * and enforcing it would refuse an agent for writing the way the code is written.
 */
export function checksBreakingExisting(
  fingerprint: CodeFingerprint,
  root: string,
  files: readonly ExistingFile[],
): BrokenCheck[] {
  const policies = fingerprintPolicies(fingerprint, root);
  const broken: BrokenCheck[] = [];
  for (const [index, check] of fingerprint.checks.entries()) {
    const policy = policies[index];
    if (policy === undefined) continue;
    const hits = files
      .filter((file) => matchesAny(policy.match.targets, file.path))
      .map((file) => ({
        file,
        count: file.lines.filter((line) => matchesAny(policy.match.content, line)).length,
      }))
      .filter((each) => each.count > 0);
    const first = hits[0];
    if (first === undefined) continue;
    broken.push({
      name: check.name,
      lines: hits.reduce((sum, each) => sum + each.count, 0),
      first: first.file.path.slice(root.length + 1),
    });
  }
  return broken;
}

/**
 * The checks whose files name nothing the repository has. Such a check describes code that
 * is not here, usually a guessed directory, and would only ever fire on code yet to come.
 */
export function checksCoveringNothing(
  fingerprint: CodeFingerprint,
  root: string,
  paths: readonly string[],
): string[] {
  const policies = fingerprintPolicies(fingerprint, root);
  return fingerprint.checks
    .filter((_check, index) => {
      const targets = policies[index]?.match.targets;
      return targets !== undefined && !paths.some((path) => matchesAny(targets, path));
    })
    .map((check) => check.name);
}

/** The paths at least one check covers, since a file no check names cannot break one. */
export function pathsChecked(
  fingerprint: CodeFingerprint,
  root: string,
  paths: readonly string[],
): string[] {
  const targets = fingerprintPolicies(fingerprint, root).map(
    (policy) => policy.match.targets,
  );
  return paths.filter((path) => targets.some((each) => matchesAny(each, path)));
}

/** The answer as written, with the dropped checks taken out and everything else kept. */
export function withoutChecks(yaml: string, dropped: ReadonlySet<string>): string {
  if (dropped.size === 0) return yaml;
  // Only called on an answer that already parsed as a mapping of sections.
  const document = parse(yaml) as Record<string, unknown>;
  const enforce = document['enforce'];
  if (Array.isArray(enforce)) {
    document['enforce'] = enforce.filter((entry: unknown) => !named(entry, dropped));
  }
  return stringify(document);
}

function named(entry: unknown, names: ReadonlySet<string>): boolean {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const name = Object.entries(entry).find(([key]) => key === 'name')?.[1];
  return typeof name === 'string' && names.has(name);
}
