import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMNOX_HOME } from '@memnox/core';
import type { Brain } from './brain';
import { ClaudeCodeBrain } from './claude-brain';
import { readAddress } from './owner';
import { runMemnox } from '../session-tools/voice-commands';
import { readVocabulary } from './vocabulary';

/** This install's own operator server, started by the brain with the node running Memnox. */
function operatorServer(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('./bin/operator.js', import.meta.url))],
  };
}

let catalogue: Promise<string> | null = null;

/** Read from this install's own help once per daemon, since commands only change with an update. */
function commandCatalogue(): Promise<string> {
  catalogue ??= runMemnox(
    ['help', '--tree'],
    CATALOGUE_TIMEOUT_MS,
    MOST_CATALOGUE_CHARS,
  ).then((ran) => (ran.exitCode === 0 ? ran.output : ''));
  return catalogue;
}

const CATALOGUE_TIMEOUT_MS = 10_000;
/** Every command fits with room to grow; a catalogue cut short would hide the commands at its end. */
const MOST_CATALOGUE_CHARS = 20_000;

/** Set to `sonnet` or `opus` for a slower, deeper voice. */
const VOICE_MODEL_VAR = 'MEMNOX_VOICE_MODEL';
const DEFAULT_VOICE_MODEL = 'haiku';

/** The brain the person already pays for, so `ask` and the daemon think with the same one. */
export function ownBrain(home: string): Brain {
  return new ClaudeCodeBrain({
    home,
    operator: operatorServer(),
    // Quick talk rather than depth: the person's own default model stays theirs everywhere else.
    model: process.env[VOICE_MODEL_VAR] ?? DEFAULT_VOICE_MODEL,
    effort: 'low',
    cwd: join(home, MEMNOX_HOME),
    vocabulary: () => readVocabulary(home),
    address: () => readAddress(home),
    catalogue: commandCatalogue,
  });
}
