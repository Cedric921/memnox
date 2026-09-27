/**
 * One command from pending changesets to a published release: `pnpm ship "what it does"`.
 *
 * It versions, commits the release, tags it `vX.Y.Z` and pushes both. The tag is what
 * `release.yml` listens for, and GitHub publishes with the repository's npm token, so
 * nobody's passkey is asked for and nothing is published from a working tree that also
 * holds unfinished work. Only the release files are staged, so that work stays put.
 */
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const RELEASE_FILES = [
  '.changeset',
  'packages/*/package.json',
  'packages/*/CHANGELOG.md',
  'packages/cli/src/defaults.ts',
];

function fail(message) {
  console.error(`ship: ${message}`);
  process.exit(1);
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

const summary = process.argv.slice(2).join(' ').trim();
if (summary === '') fail('say what the release does: pnpm ship "leases on the code being edited"');
// The subject is copy like any other, so the repository's rule on dashes holds here too.
if (/[–—]| - /.test(summary)) fail('no dashes in the summary; write the linking word instead');

if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('release from main');
if (git('diff', '--cached', '--name-only') !== '') fail('something is already staged; commit or unstage it first');
if (git('status', '--porcelain', '--', ...RELEASE_FILES) !== '')
  fail('a release file has uncommitted edits; commit them with the change they belong to');

git('fetch', '--quiet', 'origin', 'main');
if (git('rev-list', '--count', 'HEAD..origin/main') !== '0') fail('main is behind origin; pull first');

const pending = (await readdir(join(root, '.changeset'))).filter(
  (name) => name.endsWith('.md') && name !== 'README.md',
);
if (pending.length === 0) fail('no changesets pending, so there is nothing to release; add one with pnpm changeset');

run('pnpm', ['run', 'version']);
const manifest = JSON.parse(
  await readFile(join(root, 'packages', 'cli', 'package.json'), 'utf8'),
);
const tag = `v${manifest.version}`;

git('add', '-A', '--', ...RELEASE_FILES);
git('commit', '-m', `chore(release): ${manifest.version}, ${summary}`);
git('tag', tag);
// Atomic, so a rejected push never leaves a tag on GitHub that main does not contain.
run('git', ['push', '--atomic', 'origin', 'main', tag]);

console.log(`ship: ${tag} pushed; GitHub is testing and publishing it. Follow it with: gh run watch`);
