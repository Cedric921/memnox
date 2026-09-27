import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMNOX_HOME, readJsonFile, writeJsonFile } from '@memnox/core';

/**
 * Claude Code's own sandbox, turned on so the agent's shell cannot write Memnox's state or
 * the hook settings however the path is spelled, since it holds at the system call.
 */

/** Allowing every host arrived in this release; older ones would block the network outright. */
const WALL_SINCE: readonly [number, number, number] = [2, 1, 186];

const WALL_STATE = 'kernel-wall.json';

/** What the wall keeps the agent's shell from writing, in the sandbox's own path syntax. */
export const WALLED_OFF: readonly string[] = [
  '~/.memnox/',
  '~/.claude/settings.json',
  '~/.claude/settings.local.json',
  '~/.claude.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
];

type Json = Record<string, unknown>;

function objectAt(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function listAt(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((each) => typeof each === 'string') : [];
}

/**
 * Settings with the wall in them. Whatever the person already set is kept: their own
 * denials stay, and only where they said nothing does the wall open writes and the network
 * as widely as an unsandboxed shell had them, so ordinary work goes on as before.
 */
export function withKernelWall(settings: Json): Json {
  const sandbox = objectAt(settings['sandbox']);
  const filesystem = objectAt(sandbox['filesystem']);
  const network = objectAt(sandbox['network']);
  const denied = [...new Set([...listAt(filesystem['denyWrite']), ...WALLED_OFF])];
  return {
    ...settings,
    sandbox: {
      ...sandbox,
      enabled: true,
      // Otherwise a failed command is retried outside the sandbox, which is the wall's door.
      allowUnsandboxedCommands: false,
      filesystem: {
        ...filesystem,
        ...(filesystem['allowWrite'] === undefined ? { allowWrite: ['~/'] } : {}),
        denyWrite: denied,
      },
      network: {
        ...network,
        ...(network['allowedDomains'] === undefined ? { allowedDomains: ['*'] } : {}),
      },
    },
  };
}

/**
 * Settings with the sandbox as it was before the wall went up. A sandbox the wall did not
 * write is left exactly as it is, since the person runs that one on their own.
 */
export function withoutKernelWall(settings: Json, before: unknown): Json {
  const sandbox = objectAt(settings['sandbox']);
  const denied = listAt(objectAt(sandbox['filesystem'])['denyWrite']);
  if (!WALLED_OFF.every((each) => denied.includes(each))) return settings;
  const { sandbox: _wall, ...rest } = settings;
  return before === undefined || before === null ? rest : { ...rest, sandbox: before };
}

/** Whether this Claude Code can hold the wall without cutting the network off. */
export function wallSupported(version: string | null): boolean {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (found === null) return false;
  const have = [Number(found[1]), Number(found[2]), Number(found[3])];
  for (let at = 0; at < WALL_SINCE.length; at += 1) {
    const wanted = WALL_SINCE[at] ?? 0;
    if ((have[at] ?? 0) !== wanted) return (have[at] ?? 0) > wanted;
  }
  return true;
}

export function claudeVersion(): string | null {
  try {
    return execFileSync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function statePath(home: string): string {
  return join(home, MEMNOX_HOME, WALL_STATE);
}

/** The sandbox the person had before the wall, kept once so taking it down restores it. */
export async function rememberBefore(home: string, settings: Json): Promise<void> {
  if ((await readJsonFile<{ before?: unknown }>(statePath(home))) !== null) return;
  await writeJsonFile(statePath(home), { before: settings['sandbox'] ?? null });
}

export async function recalledBefore(home: string): Promise<unknown> {
  return (await readJsonFile<{ before?: unknown }>(statePath(home)))?.before ?? null;
}

/** Once the sandbox is put back, so the next wall remembers what is there then. */
export async function forgetBefore(home: string): Promise<void> {
  await rm(statePath(home), { force: true });
}
