import { execFile } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as vscode from 'vscode';
import { deviceFromLink, terminalOn } from './terminal-match';
import {
  agentInFront,
  keyPausesMs,
  typableText,
  typeLinkOf,
  waitingRequest,
} from './typing';

/**
 * Opened by the Mac. `/terminal?tty=ttys013` shows the integrated terminal on that device.
 * `/type?request=dsp_...&tty=ttys013` types an instruction the person already said yes to into
 * the agent there, reading the words from the request rather than the link, since any page can
 * open a link and a link that carried words would be a way into the agent.
 */

const PS_TIMEOUT_MS = 2_000;

/** Where the runtime writes what the Mac is asked to show, one JSON file per request. */
const DISPLAYS = join(homedir(), '.memnox', 'displays');

/** A beat before Return, since an agent reads text and Return arriving together as a paste. */
const BEFORE_RETURN_MS = 250;

/** Requests being typed now, so a link opened twice types the words once. */
const typing = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        if (uri.path === '/terminal') await showTerminal(uri.query);
        if (uri.path === '/type') await typeInstruction(uri.query);
        if (uri.path === '/close') await closeTerminal(uri.query);
      },
    }),
  );
}

export function deactivate(): void {}

async function showTerminal(query: string): Promise<void> {
  const tty = deviceFromLink(query);
  if (tty === null) return;
  (await terminalAt(tty))?.show(false);
}

async function typeInstruction(query: string): Promise<void> {
  const link = typeLinkOf(query);
  if (link === null || typing.has(link.request)) return;
  typing.add(link.request);
  try {
    const path = join(DISPLAYS, `${link.request}.json`);
    const record = await readJson(path);
    const typable = typableText(record, link.tty, new Date().toISOString());
    if ('why' in typable) {
      // Only a request still waiting is answered, so a stale or replayed link changes nothing.
      if (typable.why !== 'it was already answered' && record !== null) {
        await deliver(path, record, 'failed', typable.why);
      }
      return;
    }
    const terminal = await terminalAt(link.tty);
    if (terminal === undefined) {
      await deliver(path, record, 'failed', 'no integrated terminal holds its device');
      return;
    }
    if (!agentInFront(await foreground(link.tty))) {
      await deliver(path, record, 'failed', 'no agent is in front in its terminal');
      return;
    }
    terminal.show(false);
    const typed = await typeInto(terminal, typable.text);
    await deliver(path, record, typed === null ? 'typed' : 'failed', typed ?? undefined);
  } finally {
    typing.delete(link.request);
  }
}

/**
 * Closes the integrated terminal a session runs in, which ends the agent there, only for a close
 * Memnox asked for by voice moments ago, so a link opened by any page can close nothing.
 */
async function closeTerminal(query: string): Promise<void> {
  const link = typeLinkOf(query);
  if (link === null || typing.has(link.request)) return;
  typing.add(link.request);
  try {
    const path = join(DISPLAYS, `${link.request}.json`);
    const record = await readJson(path);
    const waiting = waitingRequest(record, link.tty, new Date().toISOString(), 'close');
    if ('why' in waiting) {
      if (waiting.why !== 'it was already answered' && record !== null) {
        await deliver(path, record, 'failed', waiting.why);
      }
      return;
    }
    const terminal = await terminalAt(link.tty);
    if (terminal === undefined) {
      await deliver(path, record, 'failed', 'no integrated terminal holds its device');
      return;
    }
    terminal.dispose();
    await deliver(path, record, 'typed');
  } finally {
    typing.delete(link.request);
  }
}

/** A key at a time, so the person watches it go in, then Return; the reason when it stopped. */
async function typeInto(terminal: vscode.Terminal, text: string): Promise<string | null> {
  const keys = [...text];
  const pauses = keyPausesMs(text);
  for (const [index, key] of keys.entries()) {
    if (terminal.exitStatus !== undefined)
      return 'its terminal closed while it was typing';
    terminal.sendText(key, false);
    await sleep(pauses[index] ?? 0);
  }
  await sleep(BEFORE_RETURN_MS);
  if (terminal.exitStatus !== undefined) return 'its terminal closed before it was sent';
  terminal.sendText('\r', false);
  return null;
}

async function terminalAt(tty: string): Promise<vscode.Terminal | undefined> {
  const found = await terminalOn(
    tty,
    vscode.window.terminals.map((terminal) => ({
      terminal,
      processId: Promise.resolve(terminal.processId),
    })),
    deviceOf,
  );
  return found ?? undefined;
}

/** What the runtime is waiting on, written whole so it never reads half a file. */
async function deliver(
  path: string,
  record: unknown,
  outcome: 'typed' | 'failed',
  reason?: string,
): Promise<void> {
  const delivered = {
    outcome,
    at: new Date().toISOString(),
    ...(reason === undefined ? {} : { reason }),
  };
  // Checked to be an object by typableText or the null test before any caller gets here.
  const next = { ...(record as Record<string, unknown>), delivered };
  const staging = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(staging, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(staging, path);
  } catch {
    // Unwritten means the Mac hears nothing and says it could not confirm, never that it was sent.
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** The terminal device a process holds, from `ps`, or null where it cannot be read. */
function deviceOf(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'tty=', '-p', String(pid)],
      { timeout: PS_TIMEOUT_MS },
      (error, out) => resolve(error === null && out.trim() !== '' ? out.trim() : null),
    );
  });
}

/** Every process on the terminal with its state, where `+` marks the one in front. */
function foreground(tty: string): Promise<string> {
  const device = tty.replace(/^\/dev\//, '');
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'stat=,comm=', '-t', device],
      { timeout: PS_TIMEOUT_MS },
      (error, out) => resolve(error === null ? out : ''),
    );
  });
}
