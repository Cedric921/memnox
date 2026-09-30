import { fileURLToPath } from 'node:url';
import type { Brain } from './brain';
import { ClaudeCodeBrain } from './claude-brain';

/** This install's own operator server, started by the brain with the node running Memnox. */
function operatorServer(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('./bin/operator.js', import.meta.url))],
  };
}

/** The brain the person already pays for, so `ask` and the daemon think with the same one. */
export function ownBrain(home: string): Brain {
  return new ClaudeCodeBrain({ home, operator: operatorServer() });
}
