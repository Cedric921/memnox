import { existsSync } from 'node:fs';
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
  const agent = textArg(args, 'agent') ?? 'claude-code';
  if (!isStartableAgent(agent)) return { typed: false, said: ONLY_APPS };
  const message = textArg(args, 'message');
  if (message === undefined) return { typed: false, said: NEEDS_MESSAGE };
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
    said: NOT_OPENED,
  };
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

const ONLY_APPS = `Only the ${Object.values(DESKTOP_APPS)
  .map((app) => app.name)
  .join(', ')} apps can be typed into.`;
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
