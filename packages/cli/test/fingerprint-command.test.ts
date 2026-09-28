import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  FINGERPRINT_COMMAND,
  FINGERPRINT_COMMAND_TEXT,
  placeFingerprintCommand,
  removeFingerprintCommand,
} from '../src/session-tools/fingerprint-command';
import { removeEverywhere, wireSessionTools } from '../src/session-tools/session-entry';

/* A hook can tell a person a repository has no fingerprint but cannot fill their prompt, so
   `/fingerprint` is the prompt as one word: put in with the session tools, taken out with them. */

async function home(claude: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'memnox-fingerprint-command-'));
  if (claude) await mkdir(join(dir, '.claude'), { recursive: true });
  return dir;
}

const commandIn = (dir: string): string => join(dir, FINGERPRINT_COMMAND);

describe('the /fingerprint command', () => {
  it('is written where Claude Code has the session tools, and taken out with them', async () => {
    const dir = await home(true);

    const placed = await wireSessionTools(dir, () => true);

    expect(await readFile(commandIn(dir), 'utf8')).toBe(FINGERPRINT_COMMAND_TEXT);
    expect(placed.files).toContain(commandIn(dir));
    await removeEverywhere(dir);
    expect(existsSync(commandIn(dir))).toBe(false);
  });

  it('is never written where Claude Code is not installed, or its tools cannot start', async () => {
    const without = await home(false);
    const unreachable = await home(true);

    await wireSessionTools(without, () => true);
    await wireSessionTools(unreachable, () => false);

    expect(existsSync(commandIn(without))).toBe(false);
    expect(existsSync(commandIn(unreachable))).toBe(false);
  });

  it('never replaces or removes a command of the same name a person wrote', async () => {
    const dir = await home(true);
    await mkdir(join(dir, '.claude', 'commands'), { recursive: true });
    await writeFile(commandIn(dir), 'my own fingerprint prompt\n');

    expect(await placeFingerprintCommand(dir)).toBe(false);
    expect(await removeFingerprintCommand(dir)).toBe(false);
    expect(await readFile(commandIn(dir), 'utf8')).toBe('my own fingerprint prompt\n');
  });

  it('brings an older copy of its own up to date, and leaves a current one alone', async () => {
    const dir = await home(true);
    await placeFingerprintCommand(dir);
    const older = FINGERPRINT_COMMAND_TEXT.replace('Record this', 'Please record this');
    await writeFile(commandIn(dir), older);

    expect(await placeFingerprintCommand(dir)).toBe(true);
    expect(await placeFingerprintCommand(dir)).toBe(false);
    expect(await readFile(commandIn(dir), 'utf8')).toBe(FINGERPRINT_COMMAND_TEXT);
  });
});
