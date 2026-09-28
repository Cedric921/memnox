/**
 * `/fingerprint` in Claude Code: a hook can tell a person a repository has no fingerprint
 * but cannot put a prompt in their input, so the prompt is one word they can type instead.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** User scope, so every repository has it without a file in any of them. */
export const FINGERPRINT_COMMAND = join('.claude', 'commands', 'fingerprint.md');

/** How a file of ours is told from one a person wrote under the same name, which is kept. */
const OURS =
  '<!-- memnox: written by memnox setup, and removed with the session tools -->';

export const FINGERPRINT_COMMAND_TEXT = `---
description: Record how this repository's code is written, as its Memnox code fingerprint
---
Record this repository's code fingerprint with Memnox.

1. Call the memnox-session "fingerprint" tool with no arguments and follow what it says to write.
2. Read enough of this repository to see how its code is actually written: its README, its layout, a few files from each layer, and how often the patterns you mean to enforce appear.
3. Call the "fingerprint" tool again with the yaml.
4. Tell me what was recorded, which checks are enforced, which were dropped and why, and remind me to review and commit .memnox/code-fingerprint.yaml.

If the repository already states one, say so and tell me what it enforces instead.

${OURS}
`;

/** Written where Claude Code is installed, and never over a command a person wrote. */
export async function placeFingerprintCommand(home: string): Promise<boolean> {
  if (!existsSync(join(home, '.claude'))) return false;
  const path = join(home, FINGERPRINT_COMMAND);
  const current = await readOrNull(path);
  if (current === FINGERPRINT_COMMAND_TEXT) return false;
  if (current !== null && !current.includes(OURS)) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, FINGERPRINT_COMMAND_TEXT, 'utf8');
  return true;
}

/** Taken out only where it is ours; true where there was one to take. */
export async function removeFingerprintCommand(home: string): Promise<boolean> {
  const path = join(home, FINGERPRINT_COMMAND);
  const current = await readOrNull(path);
  if (current === null || !current.includes(OURS)) return false;
  await rm(path, { force: true });
  return true;
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    // Absent is the ordinary case before the first setup.
    return null;
  }
}
