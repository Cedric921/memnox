import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import {
  FINGERPRINT_COMMANDS,
  placeFingerprintCommands,
  removeFingerprintCommands,
  type FingerprintCommand,
} from '../src/session-tools/fingerprint-command';
import {
  removeEverywhere,
  SESSION_TARGETS,
  wireSessionTools,
} from '../src/session-tools/session-entry';

/* A hook can tell a person a repository has no fingerprint but cannot fill their prompt, so
   `/fingerprint` is the prompt as one word in every agent: put in with the session tools,
   taken out with them, and never over a command of the same name a person wrote. */

async function home(...agents: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'memnox-fingerprint-command-'));
  for (const agent of agents) {
    const target = SESSION_TARGETS.find((each) => each.name === agent);
    if (target !== undefined)
      await mkdir(join(dir, target.installedDir), { recursive: true });
  }
  return dir;
}

function commandFor(agent: string): FingerprintCommand {
  const found = FINGERPRINT_COMMANDS.find((each) => each.agent === agent);
  if (found === undefined) throw new Error(`no command for ${agent}`);
  return found;
}

const EVERY_AGENT = FINGERPRINT_COMMANDS.map((each) => each.agent);

describe('the /fingerprint command', () => {
  it('is written for every installed agent that has the session tools, and taken out with them', async () => {
    const dir = await home(...EVERY_AGENT);

    const placed = await wireSessionTools(dir, () => true);

    for (const command of FINGERPRINT_COMMANDS) {
      expect(await readFile(join(dir, command.file), 'utf8')).toBe(command.text);
      expect(placed.files).toContain(join(dir, command.file));
    }
    await removeEverywhere(dir);
    for (const command of FINGERPRINT_COMMANDS) {
      expect(existsSync(join(dir, command.file))).toBe(false);
    }
  });

  it('is written in each agent own format and names what the person types', async () => {
    const gemini = parse(commandFor('Gemini CLI').text) as Record<string, string>;

    expect(gemini['prompt']).toContain('"fingerprint" tool');
    expect(gemini['description']).toContain('Memnox code fingerprint');
    expect(commandFor('Claude Code').text.startsWith('---\ndescription:')).toBe(true);
    expect(commandFor('Codex').typed).toBe('/prompts:fingerprint');
    expect(commandFor('Cursor').text).toContain('"fingerprint" tool');
    expect(commandFor('Windsurf').file).toContain('global_workflows');
  });

  it('is never written where the agent is not installed, or its tools cannot start', async () => {
    const onlyClaude = await home('Claude Code');
    const unreachable = await home(...EVERY_AGENT);

    await wireSessionTools(onlyClaude, () => true);
    await wireSessionTools(unreachable, () => false);

    expect(existsSync(join(onlyClaude, commandFor('Claude Code').file))).toBe(true);
    expect(existsSync(join(onlyClaude, commandFor('Codex').file))).toBe(false);
    for (const command of FINGERPRINT_COMMANDS) {
      expect(existsSync(join(unreachable, command.file))).toBe(false);
    }
  });

  it('never replaces or removes a command of the same name a person wrote', async () => {
    const dir = await home('Cursor');
    const path = join(dir, commandFor('Cursor').file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'my own fingerprint prompt\n');

    expect(await placeFingerprintCommands(dir, ['Cursor'])).toEqual([]);
    expect(await removeFingerprintCommands(dir)).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe('my own fingerprint prompt\n');
  });

  it('brings an older copy of its own up to date, and leaves a current one alone', async () => {
    const dir = await home('Claude Code');
    const command = commandFor('Claude Code');
    await placeFingerprintCommands(dir, ['Claude Code']);
    await writeFile(
      join(dir, command.file),
      command.text.replace('Record this', 'Please record this'),
    );

    expect(await placeFingerprintCommands(dir, ['Claude Code'])).toHaveLength(1);
    expect(await placeFingerprintCommands(dir, ['Claude Code'])).toEqual([]);
    expect(await readFile(join(dir, command.file), 'utf8')).toBe(command.text);
  });
});
