import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  DELIVERY,
  DISPLAY,
  DisplayRequests,
  HOUR_MS,
  SessionHosts,
  SessionTurns,
  SpokenInstructions,
  UNNAMED_SESSION,
  type DisplayDelivery,
  type DisplayRequest,
  type SessionHost,
  type SpokenInstruction,
} from '@memnox/core';
import { withEvents } from '../event-store';
import { noteFocus } from './focus';
import { textArg, type SessionToolDeps, type ToolArgs } from './read-tools';
import { changesTool } from './changes-tool';
import { liveHost } from './live-host';
import type { RewindSeams } from './rewind-tool';
import { scopeOf } from './session-scope';
import { withBrief } from './work-tools';

/**
 * Telling an agent what the person said out loud, read back first since a recognizer hears
 * "guitar push" for "git push", and handed over as the person's own request.
 */

const ROUTE = {
  /** Working: picked up after its next tool call, or as the next thing to do when its turn ends. */
  QUEUED: 'queued',
  /** Waiting in a terminal, an editor's integrated one included: typed into its prompt and sent. */
  TYPED: 'typed',
  /** Waiting in an editor: typed into its message box and sent. */
  PREFILLED: 'prefilled',
  /** Waiting where Memnox cannot reach: kept until the next time it is asked anything. */
  LATER: 'later',
} as const;

type Route = (typeof ROUTE)[keyof typeof ROUTE];

/** A turn asked longer ago than this and never handed back is an agent that went away, not one working. */
const WORKING_WITHIN_MS = 2 * HOUR_MS;

/** What runs a coding agent in a terminal, so text is only ever typed into the agent and never a shell. */
const AGENT_PROGRAMS = /^(claude|node|codex|gemini|cursor-agent|aider|opencode)$/i;

const EDITORS = /code|cursor|windsurf/i;
const TERMINALS = /iterm|terminal/i;

const SAID: Record<Route, string> = {
  queued:
    'It is working, so Memnox hands this over at its next step, beside its work: it never appears in the message box, and nothing needs typing. Say that in one sentence, like "Claude Code is busy, so I have handed it over, and it will pick it up at its next step."',
  typed:
    'The Mac typed it into its prompt and sent it, so it is starting on it now. Say so in a few words.',
  prefilled:
    'The Mac typed it into its message box in the editor and sent it, so it is starting on it now. Say so in a few words.',
  later:
    'It is not working and Memnox cannot reach where it runs, so it gets this the next time it is asked anything. Say so plainly and offer to open it.',
};

/** What the brain is told when the Mac said typing did not land, so it never says it did. */
const NOT_TYPED: Record<
  Exclude<DisplayDelivery['outcome'], typeof DELIVERY.TYPED>,
  string
> = {
  clipboard:
    'The Mac could not type it in safely, so the words are on their clipboard, and it has already said sorry and told them out loud how to paste it. Do not say sorry again, mention the clipboard or say it was sent: only ask, in one short question, whether to open the session, and keep listening for the answer.',
  failed:
    'The Mac could not type it in, and nothing was sent anywhere. Do not say it is on its way or started. Say sorry in a few words, and offer to open the session so they can see it, or to try again.',
  'not-allowed':
    'The Mac is not allowed to type yet, and it has already told them out loud how to allow it and that the words are on their clipboard. Write nothing at all this turn: every word you add repeats what they just heard. Only when they later say they switched it on, or ask you to try again, call propose_instruction with the same words and then send_instruction at once, with nothing said in between.',
};

/** The Mac never answered, so all that is known is that it was handed over. */
const UNCONFIRMED =
  'Handed to the Mac to type into its prompt, which has not confirmed it landed yet. Say it is going in now; never say it was typed, sent or started.';

const NEEDS_MESSAGE = "Pass message: the instruction in the person's words.";

export async function proposeInstructionTool(
  deps: SessionToolDeps,
  args: ToolArgs,
  seams?: RewindSeams,
): Promise<unknown> {
  const message = textArg(args, 'message');
  if (message === undefined) return { proposed: false, said: NEEDS_MESSAGE };
  const scope = await withEvents(deps.home, (store) =>
    scopeOf(store, deps, textArg(args, 'session')),
  );
  if (scope.sessionId === null || scope.sessionId === UNNAMED_SESSION) {
    return { ...scope, proposed: false, said: 'No agent session was found to tell.' };
  }
  const said = textArg(args, 'said');
  const about = textArg(args, 'about');
  const { text: told, found } = await withBrief(deps, args, message);
  const instruction = await new SpokenInstructions(deps.home).propose({
    sessionId: scope.sessionId,
    agent: scope.agent,
    message:
      about === undefined || seams === undefined
        ? told
        : await withWorkOf(deps, seams, about, told),
    ...(said === undefined ? {} : { said }),
    at: deps.now().toISOString(),
  });
  await noteFocus(deps, scope, 'told');
  return {
    ...scope,
    proposed: true,
    instruction: instruction.id,
    readBack: message,
    ...(found === undefined ? {} : { found }),
    said: 'Nothing is sent yet. If you already asked them anything in this reply, write nothing more and wait for their answer, since a second question is the same question twice. When they asked for this plainly, call send_instruction with this id now, in this same turn, with no read back and no words before it. Only when you had to guess at their words or at which session, read the gist back once as a short question, such as "Shall I ask Claude Code to push the voice branch?", and call send_instruction after they say yes.',
  };
}

/** Most files named in a hand off, so the line typed into the other agent stays one line. */
const MOST_HANDOFF_FILES = 8;

/**
 * A hand off from one agent to another: the person's words, then where the other session's work
 * is, so "have Codex review what Claude just changed" reaches Codex with the files to look at.
 */
async function withWorkOf(
  deps: SessionToolDeps,
  seams: RewindSeams,
  sessionId: string,
  message: string,
): Promise<string> {
  const changed = (await changesTool(deps, seams, { session: sessionId }).catch(
    () => ({}),
  )) as {
    repository?: string;
    files?: { shown: { path: string }[] };
  };
  const files = (changed.files?.shown ?? [])
    .slice(0, MOST_HANDOFF_FILES)
    .map((each) => each.path);
  if (files.length === 0) return message;
  const where = changed.repository === undefined ? '' : ` in ${changed.repository}`;
  return `${message} The files to look at${where} are: ${files.join(', ')}.`;
}

export async function sendInstructionTool(
  deps: SessionToolDeps,
  args: ToolArgs,
  inForeground: (tty: string) => boolean = agentInForeground,
): Promise<unknown> {
  const id = textArg(args, 'instruction');
  const moment = deps.now().toISOString();
  const store = new SpokenInstructions(deps.home);
  const instruction = id === undefined ? null : await store.take(id, moment);
  if (instruction === null) {
    return {
      sent: false,
      said: 'That instruction was used already or is more than five minutes old. They said yes to these words, so call propose_instruction with the same words and then send_instruction straight away, in this turn, with nothing said in between. Never tell them it expired, was used or is being proposed again.',
    };
  }
  const recorded = await new SessionHosts(deps.home).read(instruction.sessionId);
  // Where it runs now, since a tab recorded when it began may since be closed or someone else's.
  const host = recorded === null ? null : liveHost(recorded);
  const route = await routeFor(deps, instruction.sessionId, host, inForeground);
  if (route === ROUTE.QUEUED || route === ROUTE.LATER) {
    await store.queue(instruction, moment);
    return { sent: true, session: instruction.sessionId, how: route, said: SAID[route] };
  }
  const request = await showFor(deps, instruction, route, host);
  // Typing takes seconds and can fail, so nothing is said about it until the Mac has said how it went.
  const delivery = deps.delivered === undefined ? null : await deps.delivered(request.id);
  if (delivery === null) {
    return { sent: true, session: instruction.sessionId, how: route, said: UNCONFIRMED };
  }
  if (delivery.outcome === DELIVERY.TYPED) {
    return { sent: true, session: instruction.sessionId, how: route, said: SAID[route] };
  }
  return {
    sent: false,
    session: instruction.sessionId,
    how: delivery.outcome,
    ...(delivery.reason === undefined ? {} : { why: delivery.reason }),
    said: NOT_TYPED[delivery.outcome],
  };
}

/** How it reaches the session: its next step when working, else whatever it waits in. */
async function routeFor(
  deps: SessionToolDeps,
  sessionId: string,
  host: SessionHost | null,
  inForeground: (tty: string) => boolean,
): Promise<Route> {
  const turn = await new SessionTurns(deps.home).read(sessionId);
  const asked = turn?.promptAt;
  const working =
    asked !== undefined &&
    (turn?.endedAt === undefined || turn.endedAt < asked) &&
    deps.now().getTime() - Date.parse(asked) < WORKING_WITHIN_MS;
  if (working) return ROUTE.QUEUED;
  return waitingRoute(host, inForeground);
}

/** A prompt in a terminal is typed into, an editor's own terminal too; an editor's chat panel is prefilled. */
export function waitingRoute(
  host: SessionHost | null,
  inForeground: (tty: string) => boolean,
): Route {
  if (host === null) return ROUTE.LATER;
  const app = host.app ?? host.appPath ?? '';
  const reachable = TERMINALS.test(app) || EDITORS.test(app);
  if (host.tty !== undefined && reachable && inForeground(host.tty)) return ROUTE.TYPED;
  return EDITORS.test(app) && host.tty === undefined ? ROUTE.PREFILLED : ROUTE.LATER;
}

async function showFor(
  deps: SessionToolDeps,
  instruction: SpokenInstruction,
  route: Route,
  host: SessionHost | null,
): Promise<DisplayRequest> {
  return new DisplayRequests(deps.home).request({
    display: route === ROUTE.TYPED ? DISPLAY.TYPE : DISPLAY.PREFILL,
    sessionId: instruction.sessionId,
    agent: instruction.agent,
    title: 'Instruction',
    text: instruction.message,
    ...(host?.cwd === undefined ? {} : { cwd: host.cwd }),
    // What an editor's extension checks its link against, so a link cannot aim the words at another terminal.
    ...(route === ROUTE.TYPED && host?.tty !== undefined ? { tty: host.tty } : {}),
    at: deps.now().toISOString(),
  });
}

/** Long enough for the comet, bringing the tab forward and typing a few sentences a key at a time. */
const DELIVERY_WAIT_MS = 25_000;
const DELIVERY_POLL_MS = 200;

/** What the Mac said became of a typed instruction, or null when it said nothing in time. */
export async function awaitDelivery(
  home: string,
  requestId: string,
  waitMs: number = DELIVERY_WAIT_MS,
): Promise<DisplayDelivery | null> {
  const requests = new DisplayRequests(home);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const delivery = await requests.deliveryOf(requestId);
    if (delivery !== null) return delivery;
    await sleep(DELIVERY_POLL_MS);
  }
  return null;
}

/** Whether the terminal's foreground program is a coding agent, so the words never land in a bare shell. */
function agentInForeground(tty: string): boolean {
  try {
    const listing = execFileSync('ps', ['-o', 'stat=,comm=', '-t', basename(tty)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return listing.split('\n').some((line) => {
      const [stat, ...command] = line.trim().split(/\s+/);
      return (
        stat?.includes('+') === true && AGENT_PROGRAMS.test(basename(command.join(' ')))
      );
    });
  } catch {
    // No such terminal, or ps refused: nothing is typed anywhere unseen.
    return false;
  }
}
