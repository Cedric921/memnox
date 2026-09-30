/**
 * `memnox voice`: the key the Mac app signs its confirmations with. Trusted on first use and
 * never replaced through the daemon, so clearing it is a person's step at a terminal.
 */
import { homedir } from 'node:os';

import type { Command } from 'commander';

import { ConfirmKeys } from '@memnox/core';

import type { CliContext } from '../cli-context';
import { confirmOnTerminal, type Confirm } from '../confirm';

interface VoiceDeps {
  home: () => string;
  confirm: Confirm;
}

export function registerVoiceCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<VoiceDeps> = {},
): void {
  const deps: VoiceDeps = { home: homedir, confirm: confirmOnTerminal, ...overrides };
  const voice = program
    .command('voice')
    .description('The key the Mac app confirms with, and clearing it')
    .action(async () => runKey(context, deps));
  voice
    .command('forget-key')
    .description('Clear the confirmation key, so the Mac app can register its own again')
    .option('--yes', 'clear it without asking')
    .action(async (options: { yes?: boolean }) => runForget(context, deps, options));
}

async function runKey(context: CliContext, deps: VoiceDeps): Promise<void> {
  const { flow } = context;
  flow.open('memnox voice');
  const key = await new ConfirmKeys(deps.home()).read();
  if (key === null) {
    flow.close(
      'No confirmation key is registered, so nothing can be allowed by voice yet.',
    );
    flow.hint('Open the Memnox app on this Mac and it registers its own.');
    return;
  }
  flow.rows('Confirmation key', [
    { label: 'registered', value: key.registeredAt },
    { label: 'key', value: `P-256, ending ${key.point.slice(-8)}` },
  ]);
  flow.close('Allows by voice are signed with this key, and nothing else is accepted.');
}

async function runForget(
  context: CliContext,
  deps: VoiceDeps,
  options: { yes?: boolean },
): Promise<void> {
  const { flow } = context;
  flow.open('memnox voice forget-key');
  const keys = new ConfirmKeys(deps.home());
  if ((await keys.read()) === null) {
    flow.close('No confirmation key is registered, so there is nothing to clear.');
    return;
  }
  // No by default, since whichever key registers next is the one trusted.
  const sure =
    options.yes === true ||
    (await deps.confirm(
      'Clear the confirmation key? The next key to register is trusted, so open the Memnox app right after.',
      false,
    ));
  if (!sure) {
    flow.close('Kept the key as it was.');
    return;
  }
  await keys.forget();
  flow.close('Cleared. Open the Memnox app now, so its key is the one registered.');
}
