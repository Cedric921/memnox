import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  appLaunch,
  bundleOf,
  DELIVERY,
  wentIn,
  DESKTOP_APPS,
  DISPLAY,
  DisplayRequests,
  isStartableAgent,
  type DisplayDelivery,
  type SessionStart,
  type StartableAgent,
} from '@memnox/core';
import { unlessMacTold } from './mac-told';
import { textArg, type SessionToolDeps, type ToolArgs } from './read-tools';

/**
 * The agents' own desktop apps, Claude, Codex, Cursor and Hermes: opened on a repository with a
 * new chat, or typed into where the person already is. Each runs outside `memnox run`, so it is
 * governed by the hooks and servers Memnox put in its config, as a chat opened there by hand is.
 */

/** A message is a few sentences said in one breath, never a page. */
const MOST_MESSAGE_CHARS = 600;

/** A new chat in the app on the repository, with the task typed in and sent. */
export async function openAppStart(
  deps: SessionToolDeps,
  start: SessionStart,
  moment: string,
): Promise<unknown> {
  const launch = appLaunch(start);
  const name = DESKTOP_APPS[start.agent].name;
  const delivery = await shown(deps, {
    sessionId: start.id,
    agent: start.agent,
    name,
    cwd: start.repository,
    ...launch,
    at: moment,
  });
  const opened = { repository: basename(start.repository), app: name };
  return { ...opened, ...openedAs(delivery, launch.typed !== undefined) };
}

/**
 * Typed into the chat the person has open in the app, the way they would type it themselves,
 * for "type in Claude desktop and ask it to discuss Memnox". Their asking is their yes, as an
 * instruction to a session is, so nothing is read back first.
 */
export async function typeInAppTool(
  deps: SessionToolDeps,
  args: ToolArgs,
): Promise<unknown> {
  const message = textArg(args, 'message');
  if (message === undefined) return { typed: false, said: NEEDS_MESSAGE };
  const named = textArg(args, 'app');
  const agent = textArg(args, 'agent') ?? (named === undefined ? 'claude-code' : named);
  if (!isStartableAgent(agent)) return typeInNamedApp(deps, named ?? agent, message);
  const resolve = deps.resolveApp ?? resolveInstalledApp;
  const appPath = resolve(agent);
  if (appPath === null) return { typed: false, ...noApp(agent, resolve) };
  const moment = deps.now().toISOString();
  const delivery = await shown(deps, {
    sessionId: `app_${agent}`,
    agent,
    name: DESKTOP_APPS[agent].name,
    appPath,
    links: [],
    typed: message.split(/\r?\n/).join(' ').trim().slice(0, MOST_MESSAGE_CHARS),
    at: moment,
  });
  const result = openedAs(delivery, true);
  return { app: DESKTOP_APPS[agent].name, typed: result['started'], ...result };
}

interface AppShow {
  sessionId: string;
  agent: string;
  name: string;
  cwd?: string;
  appPath?: string;
  env?: Record<string, string>;
  links: string[];
  typed?: string;
  at: string;
}

/** Handed to the Mac to open and type, and what it said became of it, or null when it never said. */
async function shown(
  deps: SessionToolDeps,
  show: AppShow,
): Promise<DisplayDelivery | null> {
  const request = await new DisplayRequests(deps.home).request({
    display: DISPLAY.APP,
    sessionId: show.sessionId,
    agent: show.agent,
    title: show.name,
    ...(show.typed === undefined ? {} : { text: show.typed }),
    ...(show.cwd === undefined ? {} : { cwd: show.cwd }),
    ...(show.appPath === undefined ? {} : { appPath: show.appPath }),
    links: show.links,
    ...(show.env === undefined ? {} : { env: show.env }),
    at: show.at,
  });
  return deps.delivered === undefined ? null : deps.delivered(request.id);
}

/** What the brain may say, from what the Mac reported, so words never typed are never called sent. */
function openedAs(
  delivery: DisplayDelivery | null,
  hadWords: boolean,
): Record<string, unknown> {
  if (delivery === null) return { started: true, said: UNCONFIRMED };
  if (wentIn(delivery.outcome))
    return { started: true, said: hadWords ? APP_TYPED : APP_OPENED };
  if (
    delivery.outcome === DELIVERY.CLIPBOARD ||
    delivery.outcome === DELIVERY.NOT_ALLOWED
  )
    return { started: true, said: APP_CLIPBOARD };
  return {
    started: false,
    ...(delivery.reason === undefined ? {} : { why: delivery.reason }),
    said: unlessMacTold(delivery, NOT_OPENED),
  };
}

/**
 * Any other app the person named, found among what is installed, typed into the same way: the Mac
 * brings it forward and types into its message box, and says so when it finds none.
 */
async function typeInNamedApp(
  deps: SessionToolDeps,
  name: string,
  message: string,
): Promise<unknown> {
  const appPath = (deps.findApp ?? installedAppNamed)(name);
  if (appPath === null) return { typed: false, said: noSuchApp(name) };
  const shownName = basename(appPath).replace(/\.app$/, '');
  const delivery = await shown(deps, {
    sessionId: `app_${shownName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    agent: shownName,
    name: shownName,
    appPath,
    links: [],
    typed: message.split(/\r?\n/).join(' ').trim().slice(0, MOST_MESSAGE_CHARS),
    at: deps.now().toISOString(),
  });
  const result = openedAs(delivery, true);
  return { app: shownName, typed: result['started'], ...result };
}

/** Where apps are installed, the person's own folder after the shared one. */
const APP_FOLDERS = [
  '/Applications',
  join(homedir(), 'Applications'),
  '/Applications/Utilities',
];

/** An installed app by the name somebody says, spaces and case aside, the exact name first. */
export function installedAppNamed(
  name: string,
  folders: readonly string[] = APP_FOLDERS,
): string | null {
  const wanted = spoken(name);
  if (wanted === '') return null;
  const apps = folders.flatMap((folder) => {
    try {
      return readdirSync(folder)
        .filter((entry) => entry.endsWith('.app'))
        .map((entry) => join(folder, entry));
    } catch {
      return [];
    }
  });
  const named = (path: string): string => spoken(basename(path).replace(/\.app$/, ''));
  return (
    apps.find((path) => named(path) === wanted) ??
    apps.find((path) => named(path).startsWith(wanted)) ??
    null
  );
}

function spoken(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function noSuchApp(name: string): string {
  return `No app called ${name} is installed on this Mac, so nothing was typed. Say so in a sentence and ask which app they meant.`;
}

/** What to say when the agent has no desktop app on this Mac, with the agents that do. */
export function noApp(
  agent: StartableAgent,
  resolve: (agent: StartableAgent) => string | null,
): { missing: string; installed: string[]; said: string } {
  const installed = (Object.keys(DESKTOP_APPS) as StartableAgent[]).filter(
    (each) => resolve(each) !== null,
  );
  return {
    missing: `the ${DESKTOP_APPS[agent].name} app`,
    installed,
    said: `The ${DESKTOP_APPS[agent].name} desktop app is not installed on this Mac. Say so plainly, and offer its terminal agent instead, or another app from installed.`,
  };
}

/** The agent's desktop app bundle, the first place it is found installed. */
export function resolveInstalledApp(agent: StartableAgent): string | null {
  const found = DESKTOP_APPS[agent].places
    .map((place) => (place.startsWith('~/') ? join(homedir(), place.slice(2)) : place))
    .find((place) => existsSync(place));
  return found === undefined ? null : bundleOf(found);
}

const NEEDS_MESSAGE = 'Pass message: what to type, in their words.';
const APP_TYPED =
  'The app is open and the Mac typed their words into its message box and sent them, so it is answering now. Say so in a few words, like "Sent to Claude." Never say it is done.';
const APP_OPENED =
  'The app opened on that repository. Say so in a few words, like "Hermes is open in memnox runtime.", and ask what they would like it to do.';
const APP_CLIPBOARD =
  'The app is open, but the Mac could not type into it, and it already told them out loud the words are on the clipboard and how to paste them. Write nothing more.';
const UNCONFIRMED =
  'Handed to the Mac to open, which has not confirmed yet. Say it is opening; never that it is working.';
const NOT_OPENED =
  'The Mac could not open the app. Say sorry in a few words and say why in plain words; nothing was sent.';
