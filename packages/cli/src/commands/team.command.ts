/**
 * `memnox team`: signs a person in from this terminal, so the questions their team routes to
 * them can be listed and answered with `memnox inbox`, from Linux or Windows as from a phone.
 */

import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Command } from 'commander';
import { EXIT, readAccount } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { openBrowser } from '../sync/browser';
import { DEFAULT_BASE_URL } from '../sync/connect';
import {
  awaitPerson,
  enrolPerson,
  readPerson,
  requestPersonCode,
  signOutPerson,
} from '../sync/person';

interface TeamDeps {
  home: () => string;
  open: (url: string) => Promise<boolean>;
}

export function registerTeamCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<TeamDeps> = {},
): void {
  const deps: TeamDeps = { home: homedir, open: openBrowser, ...overrides };
  const team = program
    .command('team')
    .description(
      'Sign in as yourself, so the questions your team routes to you reach this terminal',
    );
  team
    .command('login')
    .description('Sign in with a code you approve in the browser')
    .option('--url <base>', 'the control plane')
    .action(async (options: { url?: string }) => {
      context.flow.open('memnox team login');
      process.exitCode = await runLogin(context, deps, options.url);
      context.flow.end();
    });
  team
    .command('logout')
    .description('Sign out, and revoke this terminal on the control plane')
    .action(async () => {
      context.flow.open('memnox team logout');
      const person = await readPerson(deps.home());
      if (person === null) return context.flow.close('Nobody is signed in here.');
      await signOutPerson(deps.home(), person);
      context.flow.close(`Signed ${person.name} out of this terminal.`);
    });
}

async function runLogin(
  context: CliContext,
  deps: TeamDeps,
  url?: string,
): Promise<number> {
  const { flow } = context;
  const account = await readAccount(deps.home());
  const baseUrl = url ?? account?.baseUrl ?? DEFAULT_BASE_URL;
  try {
    const code = await requestPersonCode(baseUrl);
    const page = code.verificationUriComplete ?? code.verificationUri;
    const opened = page === undefined ? false : await deps.open(page);
    flow.value('Your code', code.userCode);
    if (page !== undefined)
      flow.step(opened ? 'Approve it in your browser' : 'Approve it at', page);
    flow.aside('Waiting for you to approve it...');
    const granted = await awaitPerson(baseUrl, code, (ms) => sleep(ms));
    const person = await enrolPerson(deps.home(), baseUrl, granted);
    flow.close(
      `Signed in as ${person.name}. Questions your team routes to you show in memnox inbox.`,
    );
    flow.hint('memnox inbox   lists them, and memnox approve or memnox deny answers one');
    return EXIT.OK;
  } catch (err) {
    flow.fail(err instanceof Error ? err.message : String(err));
    return EXIT.FAILED;
  }
}
