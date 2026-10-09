import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SPEAKER, type ConversationLine } from '@memnox/core';
import { readWholeConversation } from './transcript';

/**
 * Sessions in the agents' own desktop apps, which run no hook Memnox can sit in: the Codex app and
 * Claude desktop's agent mode both keep every session on this Mac, so what they did is read from there.
 */

export const DESKTOP_APP = {
  CODEX: 'Codex',
  CLAUDE: 'Claude',
} as const;

export type DesktopAppName = (typeof DESKTOP_APP)[keyof typeof DESKTOP_APP];

/** How a desktop session's id begins, so every tool can tell one from a session the ledger keeps. */
const DESKTOP_PREFIX = 'dsk_';

export interface DesktopSession {
  id: string;
  app: DesktopAppName;
  /** The agent it is, as the ledger names agents. */
  agent: string;
  title?: string;
  /** The folder it works in, the first one picked where the app lets several be. */
  cwd?: string;
  startedAt: string;
  lastActiveAt: string;
  /** In the middle of a turn: one began and has not ended or been stopped. */
  working: boolean;
  /** Its log on this Mac. */
  log: string;
}

/** Where each app keeps its sessions, under the home folder. */
interface DesktopRoots {
  codex: string;
  claude: string;
}

export function desktopRoots(home: string): DesktopRoots {
  return {
    codex: join(home, '.codex', 'sessions'),
    claude: join(
      home,
      'Library',
      'Application Support',
      'Claude',
      'local-agent-mode-sessions',
    ),
  };
}

/** Every desktop session active since then, newest first. */
export function desktopSessions(roots: DesktopRoots, since: string): DesktopSession[] {
  return [
    ...codexSessions(roots.codex, since),
    ...claudeSessions(roots.claude, since),
  ].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
}

export function desktopSessionById(
  roots: DesktopRoots,
  id: string,
): DesktopSession | null {
  if (!id.startsWith(DESKTOP_PREFIX)) return null;
  return desktopSessions(roots, '').find((each) => each.id === id) ?? null;
}

/** What was said and run in it, oldest first. */
export function desktopConversation(session: DesktopSession): ConversationLine[] {
  return session.app === DESKTOP_APP.CODEX
    ? codexLines(readLines(session.log))
    : readWholeConversation(session.log);
}

/** A Codex session's conversation by its own id, from wherever Codex ran it, or nothing when it kept no log. */
export function codexConversation(root: string, id: string): ConversationLine[] {
  if (!/^[0-9a-f-]{8,80}$/i.test(id)) return [];
  const log = filesUnder(root, 3).find((path) => path.endsWith(`-${id}.jsonl`));
  return log === undefined ? [] : codexLines(readLines(log));
}

/** The Codex app's sessions, which share a folder with Codex in a terminal, told apart by what started them. */
const CODEX_DESKTOP = 'Codex Desktop';

function codexSessions(root: string, since: string): DesktopSession[] {
  const found: DesktopSession[] = [];
  for (const file of filesUnder(root, 3).filter((path) => path.endsWith('.jsonl'))) {
    if (modifiedAt(file) < since) continue;
    const session = codexSession(file);
    if (session !== null) found.push(session);
  }
  return found;
}

/** A Codex log made by the desktop app, or null for one Codex ran in a terminal or one that cannot be read. */
function codexSession(file: string): DesktopSession | null {
  const entries = readLines(file);
  const meta = entries.find((each) => each['type'] === 'session_meta');
  const payload = objectOf(meta?.['payload']);
  if (payload === null || payload['originator'] !== CODEX_DESKTOP) return null;
  const id = typeof payload['id'] === 'string' ? payload['id'] : null;
  if (id === null) return null;
  const lines = codexLines(entries);
  const first = lines.find((line) => line.who === SPEAKER.PERSON);
  const stamps = entries
    .map((each) => each['timestamp'])
    .filter(isText)
    .sort();
  return {
    id: `${DESKTOP_PREFIX}codex_${id}`,
    app: DESKTOP_APP.CODEX,
    agent: 'codex',
    ...(first === undefined ? {} : { title: first.text }),
    ...(typeof payload['cwd'] === 'string' ? { cwd: payload['cwd'] } : {}),
    startedAt: stamps[0] ?? '',
    lastActiveAt: stamps[stamps.length - 1] ?? '',
    working: codexWorking(entries),
    log: file,
  };
}

/** A turn began and nothing since says it completed or was stopped. */
function codexWorking(entries: readonly Record<string, unknown>[]): boolean {
  let working = false;
  for (const entry of entries) {
    const kind = objectOf(entry['payload'])?.['type'];
    if (kind === 'task_started') working = true;
    if (kind === 'task_complete' || kind === 'turn_aborted') working = false;
  }
  return working;
}

/** The context Codex hands itself, which arrives as the person's message and never is. */
const CODEX_CONTEXT = /^\s*<[a-z_-]+>/;

/** What the person asked, what Codex answered and the tools it ran, from its log. */
function codexLines(entries: readonly Record<string, unknown>[]): ConversationLine[] {
  const lines: ConversationLine[] = [];
  for (const entry of entries) {
    const payload = objectOf(entry['payload']);
    const at = isText(entry['timestamp']) ? entry['timestamp'] : '';
    if (entry['type'] !== 'response_item' || payload === null) continue;
    if (payload['type'] === 'message') {
      const text = textsOf(payload['content']);
      if (text === '' || CODEX_CONTEXT.test(text)) continue;
      if (payload['role'] === 'user') lines.push({ at, who: SPEAKER.PERSON, text });
      if (payload['role'] === 'assistant') lines.push({ at, who: SPEAKER.AGENT, text });
    } else if (
      payload['type'] === 'function_call' ||
      payload['type'] === 'custom_tool_call'
    ) {
      if (isText(payload['name']))
        lines.push({ at, who: SPEAKER.TOOL, text: payload['name'] });
    }
  }
  return lines;
}

function textsOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => objectOf(part)?.['text'])
    .filter(isText)
    .join('\n')
    .trim();
}

/** Claude desktop's agent sessions: one record each, with its conversation logged beside it. */
function claudeSessions(root: string, since: string): DesktopSession[] {
  const found: DesktopSession[] = [];
  for (const file of filesUnder(root, 2)) {
    const name = file.split('/').pop() ?? '';
    if (!name.startsWith('local_') || !name.endsWith('.json')) continue;
    const session = claudeSession(file, since);
    if (session !== null) found.push(session);
  }
  return found;
}

/** Its record, read only when it was active since then, since its log can run to megabytes. */
function claudeSession(file: string, since: string): DesktopSession | null {
  let record: Record<string, unknown> | null;
  try {
    record = objectOf(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
  if (record === null || record['isArchived'] === true || !isText(record['sessionId']))
    return null;
  if (isoOf(record['lastActivityAt']) < since) return null;
  const log = join(file.replace(/\.json$/, ''), 'audit.jsonl');
  const folders = Array.isArray(record['userSelectedFolders'])
    ? record['userSelectedFolders'].filter(isText)
    : [];
  return {
    id: `${DESKTOP_PREFIX}claude_${record['sessionId']}`,
    app: DESKTOP_APP.CLAUDE,
    agent: 'claude-code',
    ...(isText(record['title']) ? { title: record['title'] } : {}),
    ...(folders[0] === undefined ? {} : { cwd: folders[0] }),
    startedAt: isoOf(record['createdAt']),
    lastActiveAt: isoOf(record['lastActivityAt']),
    working: claudeWorking(readLines(log)),
    log,
  };
}

/** A message from the person with no result after it is a turn still going. */
function claudeWorking(entries: readonly Record<string, unknown>[]): boolean {
  let working = false;
  for (const entry of entries) {
    if (typeof entry['parent_tool_use_id'] === 'string') continue;
    const content = objectOf(entry['message'])?.['content'];
    if (entry['type'] === 'user' && typeof content === 'string') working = true;
    if (entry['type'] === 'result') working = false;
  }
  return working;
}

function isoOf(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value).toISOString()
    : '';
}

/** Files at most this many folders down, quietly skipping what cannot be read. */
function filesUnder(root: string, depth: number): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isFile()) return [path];
    return entry.isDirectory() && depth > 0 ? filesUnder(path, depth - 1) : [];
  });
}

function modifiedAt(path: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return '';
  }
}

/** Each JSON line of a log as an object, skipping any line torn mid write. */
function readLines(path: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').flatMap((line) => {
    try {
      const parsed = objectOf(JSON.parse(line));
      return parsed === null ? [] : [parsed];
    } catch {
      return [];
    }
  });
}

function objectOf(value: unknown): Record<string, unknown> | null {
  // A parsed JSON object is a string-keyed record; anything else is not one.
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}
