import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  AGENT_ID,
  DESKTOP_APPS,
  DISPLAY,
  DISPLAY_TEXT_LIMIT,
  DISPLAY_VIA,
  DisplayRequests,
  INSTALL_PLACES,
  isStartableAgent,
  SessionHosts,
  SessionStarts,
  STARTABLE_AGENT,
  startCommand,
  type SessionStart,
  type StartableAgent,
  WorkBriefs,
} from '@memnox/core';
import { noApp, openAppStart, resolveInstalledApp } from './app-tools';
import { launched, startInPane, startInPanel } from './start-routes';
import { mainCheckoutOf } from './main-checkout';
import { keepSurface } from './start-surface';
import { editorName, PLACE, placeFor, surfaceOf } from './start-place';
import { textArg, type SessionToolDeps, type ToolArgs } from './read-tools';
import { withBrief } from './work-tools';
import { APP_BUNDLE_SUFFIX, SAID, TOOL_ARG } from './session-tools.constants';

/**
 * Starting a new agent session out loud: "start Claude in memnox cloud on the failing test". It
 * is read back first, and on a yes a new terminal tab opens in that repository and the line that
 * starts the agent under `memnox run` is typed into it, so the new session is governed from its first step.
 */

/** Long enough for any task said in one breath, short enough that the typed line stays one line. */
const MOST_TASK_CHARS = 400;

export async function proposeStartTool(
  deps: SessionToolDeps,
  args: ToolArgs,
): Promise<unknown> {
  const agent = textArg(args, TOOL_ARG.AGENT) ?? AGENT_ID.CLAUDE_CODE;
  if (!isStartableAgent(agent)) return { proposed: false, said: ONLY_KNOWN_AGENTS };
  const place = await placeFor(deps, args, agent);
  if (place.kind === PLACE.NO_EDITOR) return { proposed: false, said: NO_EDITOR };
  if (place.kind === PLACE.NO_TERMINAL) return { proposed: false, said: NO_TERMINAL };
  const inApp = place.kind === PLACE.APP;
  const resolve = resolverFor(deps, inApp);
  const command = resolve(agent);
  if (command === null)
    return { proposed: false, ...(inApp ? noApp : notInstalled)(agent, resolve) };
  // Asked for only a session, it starts waiting for them rather than on a task nobody gave it.
  const task = textArg(args, 'task') ?? '';
  const known = await knownRepositories(deps);
  const { text, brief, found } = await withBrief(deps, args, task, MOST_TASK_CHARS);
  const chosen = await repositoryFor(deps, textArg(args, 'repository'), known, brief);
  if (chosen === null) return noRepository(known);
  const said = textArg(args, 'said');
  const start = await new SessionStarts(deps.home).propose({
    agent,
    command,
    repository: chosen.path,
    task: text,
    ...(textArg(args, TOOL_ARG.HOLD_CREDENTIALS) === SAID.YES ? HELD : {}),
    ...(brief === undefined ? {} : { brief }),
    ...(inApp ? { app: command } : {}),
    ...whereItStarts(place, agent, args),
    ...(said === undefined ? {} : { said }),
    at: deps.now().toISOString(),
  });
  return {
    ...readBackOf(deps, start, chosen, task),
    ...(found === undefined ? {} : { found }),
  };
}

/** Started with its credentials kept away from it. */
const HELD = { holdCredentials: true } as const;

/** Where the start runs beyond a terminal tab: an editor or its Claude Code panel, a pane, or a terminal app. */
function whereItStarts(
  place: Awaited<ReturnType<typeof placeFor>>,
  agent: StartableAgent,
  args: ToolArgs,
): Pick<SessionStart, 'editor' | 'panel' | 'pane' | 'terminal'> {
  if (place.kind === PLACE.EDITOR) {
    // Only Claude Code has a panel Memnox can start a conversation in.
    const panel =
      agent === AGENT_ID.CLAUDE_CODE && textArg(args, TOOL_ARG.PANEL) === SAID.YES;
    return { editor: place.path, ...(panel ? { panel } : {}) };
  }
  if (place.kind === PLACE.PANE) return { pane: place.multiplexer };
  if (place.kind === PLACE.TERMINAL_APP) return { terminal: place.path };
  return {};
}

/** The agent's command, or with app "true" its desktop app, each found where it is installed. */
function resolverFor(
  deps: SessionToolDeps,
  inApp: boolean,
): (agent: StartableAgent) => string | null {
  return inApp
    ? (deps.resolveApp ?? resolveInstalledApp)
    : (deps.resolveCommand ?? resolveInstalled);
}

/** What the brain reads back, with the app named when it opens in one rather than a terminal. */
function readBackOf(
  deps: SessionToolDeps,
  start: SessionStart,
  chosen: ChosenRepository,
  task: string,
): Record<string, unknown> {
  return {
    proposed: true,
    start: start.id,
    repository: basename(chosen.path),
    ...(chosen.from === undefined ? {} : { repositoryFrom: chosen.from }),
    readBack: task,
    ...(start.app === undefined
      ? {}
      : { in: `the ${DESKTOP_APPS[start.agent].name} app` }),
    ...(start.editor === undefined
      ? {}
      : {
          in:
            start.panel === true
              ? `a new conversation in the Claude Code panel in ${editorName(deps, start)}`
              : `a new terminal in ${editorName(deps, start)}`,
        }),
    ...(start.pane === undefined ? {} : { in: `a new ${start.pane} window` }),
    ...(start.terminal === undefined
      ? {}
      : { in: `a new ${basename(start.terminal, APP_BUNDLE_SUFFIX)} window` }),
    ...(start.holdCredentials === true ? { holdsCredentials: true } : {}),
    said: READ_BACK,
  };
}

/** Where the work goes, and how it was chosen when the person named no repository. */
interface ChosenRepository {
  path: string;
  /** Said in the read back, so a guess can be corrected before anything starts. */
  from?: string;
}

/**
 * The repository they named, or with none named, the one the ticket lives in, and failing that
 * the one their last session worked in.
 */
async function repositoryFor(
  deps: SessionToolDeps,
  named: string | undefined,
  known: readonly string[],
  brief: string | undefined,
): Promise<ChosenRepository | null> {
  if (named !== undefined) {
    const path = repositoryNamed(named, known);
    return path === null ? null : { path };
  }
  const ticket = brief === undefined ? null : await new WorkBriefs(deps.home).read(brief);
  const fromTicket = ticket?.sources
    .map((source) => source.link?.match(/github\.com\/[^/]+\/([^/#?]+)/)?.[1])
    .find((name) => name !== undefined);
  const byTicket = known.find((each) => basename(each) === fromTicket);
  if (byTicket !== undefined)
    return { path: byTicket, from: 'the repository its ticket is filed in' };
  const hosts = (await new SessionHosts(deps.home).all())
    .filter((host) => host.cwd !== undefined && isAbsolute(host.cwd))
    .sort((a, b) => b.seenAt.localeCompare(a.seenAt));
  const last = hosts
    .map((host) => mainCheckoutOf(host.cwd ?? ''))
    .find((each) => known.includes(each));
  return last === undefined
    ? null
    : { path: last, from: 'the repository your last session worked in' };
}

/** The repositories it could see, so the voice offers the closest names rather than asking again. */
function noRepository(known: readonly string[]): Record<string, unknown> {
  return {
    proposed: false,
    known: known.map((each) => basename(each)),
    said: NO_SUCH_REPOSITORY,
  };
}

export async function startSessionTool(
  deps: SessionToolDeps,
  args: ToolArgs,
): Promise<unknown> {
  const id = textArg(args, 'start');
  const moment = deps.now().toISOString();
  const start =
    id === undefined ? null : await new SessionStarts(deps.home).take(id, moment);
  if (start === null) return { started: false, said: GONE };
  await keepSurface(deps.home, start.agent, surfaceOf(deps, start));
  if (start.app !== undefined) return openAppStart(deps, start, moment);
  const line = startCommand(start);
  // Cut short, the quotes would not close, so a line too long for the screen is never typed at all.
  if (line.length > DISPLAY_TEXT_LIMIT) return { started: false, said: TOO_LONG };
  if (start.pane !== undefined) return startInPane(deps, start, line, moment);
  if (start.panel === true) return startInPanel(deps, start, moment);
  const request = await new DisplayRequests(deps.home).request({
    display: DISPLAY.LAUNCH,
    sessionId: start.id,
    agent: start.agent,
    title: start.agent,
    text: line,
    cwd: start.repository,
    // The Mac opens this editor on the repository and its Memnox extension starts the agent there.
    ...(start.editor === undefined ? {} : { appPath: start.editor }),
    // Or opens a window of this terminal app on the repository and types the line into it.
    ...(start.terminal === undefined
      ? {}
      : { appPath: start.terminal, via: DISPLAY_VIA.TERMINAL_APP }),
    at: moment,
  });
  const delivery = deps.delivered === undefined ? null : await deps.delivered(request.id);
  return launched(deps, start, delivery, moment);
}

const TOO_LONG =
  'That task is too long to type as one line. Ask them for it in a sentence or two, and propose it again.';

/** What to say when the agent's command is nowhere on this Mac, with the agents that are. */
function notInstalled(
  agent: StartableAgent,
  resolve: (agent: StartableAgent) => string | null,
): { missing: string; installed: string[]; said: string } {
  const installed = (Object.keys(STARTABLE_AGENT) as StartableAgent[]).filter(
    (each) => resolve(each) !== null,
  );
  return {
    missing: STARTABLE_AGENT[agent],
    installed,
    said: `The ${STARTABLE_AGENT[agent]} command is nowhere on this Mac, neither on PATH nor where it is usually installed, so that agent cannot be started from a terminal. Say so plainly, and offer one from installed if there is one.`,
  };
}

/** The agent's bare command when the person's own shell finds it, else the full path it is installed at. */
function resolveInstalled(agent: StartableAgent): string | null {
  const command = STARTABLE_AGENT[agent];
  if (inShell(command)) return command;
  return (
    INSTALL_PLACES[agent]
      .map((place) => (place.startsWith('~/') ? join(homedir(), place.slice(2)) : place))
      .find(runnable) ?? null
  );
}

/** Asked of an interactive login shell, since that is the PATH the new terminal tab will have, `.zshrc` included. */
function inShell(command: string): boolean {
  try {
    execFileSync(process.env['SHELL'] ?? '/bin/zsh', ['-lic', `command -v ${command}`], {
      stdio: 'ignore',
      timeout: 6_000,
    });
    return true;
  } catch {
    return false;
  }
}

function runnable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const ONLY_KNOWN_AGENTS = `Only ${Object.keys(STARTABLE_AGENT).join(' or ')} can be started by voice.`;
const NO_SUCH_REPOSITORY =
  'No repository on this Mac goes by that name. Offer the closest from known, by name.';
const READ_BACK =
  'Nothing has started. Read it back once, as one whole sentence that ends in a courteous question, saying the app when in names one, such as "Shall I open the Codex app in memnox runtime to review your changes?", "Shall I start Codex in memnox macos to review the changes?" or "I can start Claude Code in memnox cloud on the failing auth test. Would you like me to go ahead?", varying the words. Say nothing before it and nothing after the question. Call start_session with this id only after they say yes. When they asked for exactly this plainly, the agent, the repository and what to do, or only to open an app such as "open Hermes", or they already said yes to it or corrected it to this, skip the read back: their asking is their yes, so call start_session with this id now. Never ask the same thing twice.';
const GONE =
  'That start is gone or more than five minutes old. Read it back again with propose_start.';
const NO_TERMINAL =
  'The terminal they named is not installed on this Mac, or no tmux or WezTerm is running to open a window in, so nothing was proposed. Say so plainly and offer a new terminal tab instead, as a question.';
const NO_EDITOR =
  'The editor they named is not installed on this Mac, so nothing was proposed. Say so plainly and offer a new terminal tab instead, as a question; never start it anywhere else unasked.';

/**
 * Every repository a session has run in, the repositories beside them, and every one in the
 * folders people keep code in, so a project nobody has opened with an agent yet is still found.
 */
export async function knownRepositories(deps: SessionToolDeps): Promise<string[]> {
  const roots = new Set<string>(repositoriesUnder(deps.home));
  for (const host of await new SessionHosts(deps.home).all()) {
    if (host.cwd !== undefined && isAbsolute(host.cwd))
      roots.add(mainCheckoutOf(host.cwd));
  }
  for (const root of [...roots]) {
    for (const sibling of repositoriesIn(dirname(root))) roots.add(sibling);
  }
  return [...roots].filter((each) => existsSync(join(each, '.git')));
}

/** Where people keep code, under their home folder. */
const CODE_FOLDERS: readonly string[] = [
  'Documents',
  'Developer',
  'Projects',
  'projects',
  'Code',
  'code',
  'src',
  'dev',
  'repos',
  'workspace',
  'github',
  'GitHub',
  'Desktop',
  'Sites',
  'work',
];

/** Deep enough for ~/Documents/company/project, shallow enough to answer while they wait. */
const CODE_DEPTH = 3;
/** A bound on the folders read, so a home full of photos never stalls an answer. */
const MOST_FOLDERS_READ = 3_000;
/** Never a repository anyone means, and often enormous. */
const SKIPPED = new Set(['node_modules', 'Library', 'vendor', 'build', 'dist']);

function repositoriesUnder(home: string): string[] {
  const found: string[] = [];
  let read = 0;
  const walk = (folder: string, depth: number): void => {
    if (read >= MOST_FOLDERS_READ) return;
    read += 1;
    let entries: Dirent[];
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      // An unreadable folder has no repositories anyone can be sent to.
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED.has(entry.name))
        continue;
      const path = join(folder, entry.name);
      if (existsSync(join(path, '.git'))) found.push(path);
      else if (depth < CODE_DEPTH) walk(path, depth + 1);
    }
  };
  for (const folder of CODE_FOLDERS) walk(join(home, folder), 1);
  return found;
}

function repositoriesIn(folder: string): string[] {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((each) => each.isDirectory() && existsSync(join(folder, each.name, '.git')))
      .map((each) => join(folder, each.name));
  } catch {
    // An unreadable folder has no repositories anyone can be sent to.
    return [];
  }
}

/**
 * The repository whose name sounds like what was said: "memnox cloud" is memnox-cloud, and
 * "my locks runtime", which is how a recognizer hears it, is still memnox-runtime, because
 * runtime names only one of them.
 */
export function repositoryNamed(said: string, known: readonly string[]): string | null {
  const wanted = spoken(said);
  if (wanted === '') return null;
  const byName = known.map((each) => ({ path: each, name: spoken(basename(each)) }));
  const exact =
    byName.find((each) => each.name === wanted) ??
    byName.find((each) => each.name.includes(wanted));
  if (exact !== undefined) return exact.path;
  const distinctive = said
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4)
    .map((word) => byName.filter((each) => each.name.includes(word)))
    .find((matches) => matches.length === 1)?.[0];
  if (distinctive !== undefined) return distinctive.path;
  const closest = byName
    .map((each) => ({ ...each, likeness: likeness(wanted, each.name) }))
    .sort((a, b) => b.likeness - a.likeness)[0];
  return closest !== undefined && closest.likeness >= CLOSE_ENOUGH ? closest.path : null;
}

/** How alike two spellings are, from nothing to the same, by the edits between them. */
function likeness(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - editsBetween(a, b) / longest;
}

/** Close enough that a misheard name is the one meant, far enough that a different project is not. */
const CLOSE_ENOUGH = 0.6;

function editsBetween(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const swap = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, swap));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function spoken(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}
