import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMNOX_HOME } from '@memnox/core';
import type { Brain } from './brain';
import { ClaudeCodeBrain } from './claude-brain';
import { readVocabulary } from './vocabulary';

/** This install's own operator server, started by the brain with the node running Memnox. */
function operatorServer(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('./bin/operator.js', import.meta.url))],
  };
}

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
  });
}
