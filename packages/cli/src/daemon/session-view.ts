import { basename, isAbsolute, normalize } from 'node:path';
import {
  AGENT_ID_PREFIX,
  buildReplay,
  DECISION_EFFECT,
  DELIVERY,
  DELIVERY_OPERATION,
  LEDGER_SESSION_LIMIT,
  Milestones,
  NodeGit,
  NodeWorktree,
  REPLAY_STEP,
  SessionHosts,
  SPEAKER,
  statementOfPrompt,
  type CardExcerpt,
  type CardFile,
  type DisplayHost,
  type SessionCard,
  type SessionHost,
  type ConversationLine,
  type ReplayStep,
  type SessionView,
  type SessionViewStep,
} from '@memnox/core';
import { displayName, readNames } from '../agents/names';
import { readStatus } from '../commands/status.command';
import { withEvents } from '../event-store';
import type { SessionToolDeps } from '../session-tools/read-tools';
import type { RewindSeams } from '../session-tools/rewind-tool';
import { SESSION_STATE, sessionsTool } from '../session-tools/sessions-tool';
import { excerptOf } from '../session-tools/show-tool';
import {
  readConversation,
  readLastAnswer,
  latestPersonLine,
  readLatestAsk,
  readOpeningAsk,
  sessionTranscript,
} from './transcript';
import { branchAt, repositoryAround } from '../session-tools/repository-root';
import {
  desktopConversation,
  desktopRoots,
  desktopSessionById,
} from './desktop-sessions';
import { changesIn, fileDiff } from './session-changes';
import { conversationOf } from './waiting-feed';
import { readBrainSessions } from '../operator/brain-sessions';
import { idsOf } from '../session-tools/session-aliases';
import {
  hermesCards,
  hermesLastAnswer,
  hermesView,
  isHermesSession,
} from './hermes-view';

/**
 * A session as it is right now, for the live window the Mac app opens on it: the same facts
 * the voice reads from sessions, replay and changes, gathered in one answer it can poll.
 */

/** The whole session as the live window keeps it, read again every two seconds; a ledger row is a short line. */
const MOST_STEPS = 300;
/** Every file a session is likely to touch, so the counts over them add up to the real change. */
const MOST_FILES = 60;
/** As long a command line as a window row shows before it is cut. */
const MOST_STEP_CHARS = 90;
/** The window polls every couple of seconds, and a diff of the tree is not that cheap. */
const FILES_FRESH_MS = 8_000;
/** As much of the agent's last answer as a card shows, where the work stands rather than the whole report. */
const MOST_LAST_SAID_CHARS = 320;

interface SessionRow {
  session: string;
  agent: string;
  task?: string;
  lastAsk?: string;
  state: string;
  turn?: string;
  repositories: string[];
  runningIn?: string;
  where?: string;
  started?: string;
  lastActive?: string;
  waitingOnYou: number;
  actions?: number;
  paused?: string;
  notAnAgent?: string;
  subagents?: {
    launched: { description: string }[];
    working: { type?: string; lastTool?: string }[];
  };
}

/** As many lines as a Claude Code transcript shows in the live window. */
const MOST_DESKTOP_LINES = 160;

export class SessionViews {
  private readonly files = new Map<string, { at: number; code: Code }>();
  /** Each session's first request once found, since it never changes and the card asks every poll. */
  private readonly openings = new Map<string, string>();

  constructor(
    private readonly home: string,
    private readonly now: () => Date = () => new Date(),
    /** Where the agent's own home is, which holds its transcripts; the same home outside tests. */
    private readonly transcripts: string = home,
  ) {}

  /** The sessions lately as cards, the most recently active first, for the switcher. */
  async list(): Promise<SessionCard[]> {
    const rows = ((await sessionsTool(this.deps(), { hours: '72' })) as SessionRow[])
      .filter((each) => each.notAnAgent === undefined)
      // A session the person closed is not theirs to track any more, on screen or in what the voice knows.
      .filter((each) => each.state !== SESSION_STATE.ENDED)
      // Work happening now first, since a turn in progress records little while it thinks.
      .sort(
        (a, b) =>
          Number(workingNow(b)) - Number(workingNow(a)) ||
          (b.lastActive ?? '').localeCompare(a.lastActive ?? ''),
      )
      .slice(0, MOST_CARDS);
    const names = await readNames(this.home);
    const hosts = new SessionHosts(this.home);
    const cards = await Promise.all(
      rows.map(async (row) => cardOf(row, names, await hosts.read(row.session))),
    );
    // Hermes keys no session in the ledger, so its own are read beside, newest first with the rest.
    const hermes = hermesCards(this.transcripts, this.now(), nameOf(names, 'hermes'), {
      ownSessions: await readBrainSessions(this.home),
    });
    return [...cards, ...hermes]
      .sort((a, b) => (b.lastActive ?? '').localeCompare(a.lastActive ?? ''))
      .slice(0, MOST_CARDS);
  }

  async view(sessionId: string): Promise<SessionView | null> {
    if (isHermesSession(sessionId)) {
      const names = await readNames(this.home);
      const agentName = nameOf(names, 'hermes');
      return hermesView(this.transcripts, sessionId, { now: this.now(), agentName });
    }
    const deps = this.deps();
    const rows = (await sessionsTool(deps, { hours: '72' })) as SessionRow[];
    const row = rows.find((each) => each.session === sessionId);
    if (row === undefined) return null;
    const [steps, code, names, host, lastSaid, latestAsk] = await Promise.all([
      this.steps(sessionId),
      this.changed(deps, sessionId),
      readNames(this.home),
      new SessionHosts(this.home).read(sessionId).catch(() => null),
      this.lastAnswer(sessionId).catch(() => null),
      this.latestAsk(sessionId).catch(() => undefined),
    ]);
    // A session that only ran commands wrote nowhere, so the folder it was opened in names its repository.
    const opened = host?.cwd === undefined ? null : repositoryAround(host.cwd);
    const repository = row.repositories[0] ?? opened ?? undefined;
    const root = repository === undefined ? null : repositoryAround(repository);
    const branch = root === null ? null : branchAt(root);
    const task = row.task ?? (await this.openingAsk(sessionId));
    return viewOf(row, {
      sessionId,
      agentName: nameOf(names, row.agent),
      steps,
      code,
      task,
      repository,
      branch,
      lastSaid,
      latestAsk,
      conversation: await this.conversation(sessionId),
    });
  }

  /**
   * What the person last typed, from the agent's own transcript, which marks a helper's report or a harness notice
   * as not theirs; undefined where no transcript is readable, so the ask the prompt hook kept stands in.
   */
  private async latestAsk(sessionId: string): Promise<string | null | undefined> {
    const desktop = desktopSessionById(desktopRoots(this.home), sessionId);
    if (desktop !== null) {
      return latestPersonLine(desktopConversation(desktop));
    }
    const path = await sessionTranscript(this.home, sessionId, this.transcripts);
    return path === null ? undefined : readLatestAsk(path);
  }

  /** What the agent said to end its latest turn, in full, for the voice to answer "what did it find". */
  async lastAnswer(sessionId: string): Promise<string | null> {
    if (isHermesSession(sessionId)) return hermesLastAnswer(this.transcripts, sessionId);
    const path = await sessionTranscript(this.home, sessionId, this.transcripts);
    return path === null ? null : readLastAnswer(path);
  }

  /** What the session was opened for when no task was noted: the person's first request in it, kept once found. */
  private async openingAsk(sessionId: string): Promise<string | undefined> {
    const kept = this.openings.get(sessionId);
    if (kept !== undefined) return kept;
    const desktop = desktopSessionById(desktopRoots(this.home), sessionId);
    const path =
      desktop === null
        ? await sessionTranscript(this.home, sessionId, this.transcripts)
        : null;
    const found =
      desktop === null
        ? path === null
          ? null
          : readOpeningAsk(path)
        : (desktopConversation(desktop).find((line) => line.who === SPEAKER.PERSON)
            ?.text ?? null);
    if (found === null) return undefined;
    this.openings.set(sessionId, found);
    return found;
  }

  /** What was said, read from the agent's own transcript, or nothing where it keeps none Memnox can read. */
  private async conversation(
    sessionId: string,
  ): Promise<{ conversation?: ConversationLine[] }> {
    const desktop = desktopSessionById(desktopRoots(this.home), sessionId);
    if (desktop !== null) {
      const lines = desktopConversation(desktop).slice(-MOST_DESKTOP_LINES);
      return lines.length === 0 ? {} : { conversation: lines };
    }
    const path = await sessionTranscript(this.home, sessionId, this.transcripts);
    if (path === null) return {};
    const lines = readConversation(path);
    return lines.length === 0 ? {} : { conversation: lines };
  }

  private async steps(sessionId: string): Promise<SessionViewStep[]> {
    const ids = await idsOf(this.home, sessionId);
    // Its edits can record under the agent's own id, which alone would leave only the network here.
    const events = (
      await withEvents(this.home, (store) =>
        Promise.all(
          ids.map((id) => store.query({ sessionId: id, limit: LEDGER_SESSION_LIMIT })),
        ),
      )
    )
      .flat()
      .sort((a, b) => a.at.localeCompare(b.at));
    return buildReplay({ sessionId, events })
      .steps.filter((step) => step.kind === REPLAY_STEP.ACTION)
      .slice(-MOST_STEPS)
      .map(stepOf);
  }

  /** One changed file's diff, for the live window to open under the file's name. */
  async diff(sessionId: string, path: string): Promise<CardExcerpt | null> {
    return fileDiff(this.deps(), SEAMS, sessionId, path);
  }

  /** The files it changed and the lines of the busiest, kept a few seconds, since every poll would otherwise diff the tree. */
  private async changed(deps: SessionToolDeps, sessionId: string): Promise<Code> {
    const kept = this.files.get(sessionId);
    const moment = this.now().getTime();
    if (kept !== undefined && moment - kept.at < FILES_FRESH_MS) return kept.code;
    const answer = await changesIn(deps, SEAMS, sessionId);
    const shown = answer.files?.shown ?? [];
    const others = await Promise.all(
      (answer.alsoChanged ?? []).map((each) =>
        changesIn(deps, SEAMS, sessionId, each.repository),
      ),
    );
    // Every repository it wrote in, named when there is more than one, so work in two is never half shown.
    const named = others.length > 0;
    const files = [answer, ...others]
      .flatMap((each) =>
        (each.files?.shown ?? []).map((file) => ({
          ...file,
          path: named ? `${basename(each.repository ?? '')}/${file.path}` : file.path,
        })),
      )
      .slice(0, MOST_FILES)
      .map((each) => ({
        path: each.path,
        ...(each.added === null ? {} : { added: each.added }),
        ...(each.removed === null ? {} : { removed: each.removed }),
      }));
    const excerpt = await excerptOf(deps, SEAMS, sessionId, shown).catch(() => null);
    const code: Code = excerpt === null ? { files } : { files, excerpt };
    this.files.set(sessionId, { at: moment, code });
    return code;
  }

  deps(): SessionToolDeps {
    return {
      home: this.home,
      cwd: this.home,
      agent: 'claude-code',
      env: {},
      now: this.now,
      readStatus,
      milestonesAt: async (place) =>
        SEAMS.build(place)
          .list()
          .catch(() => []),
      brief: async () => null,
    };
  }
}

/** The start of the agent's last answer, cut at a word, since the card shows where things stand rather than the report. */
function clipped(text: string): string {
  // Markdown marks read as stray symbols on a card, so headings, bullets, bold and code ticks go.
  const flat = text
    .split('\n')
    .map((line) => line.replace(/^\s*(#+|[-*]|\d+\.)\s+/, ''))
    .join(' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= MOST_LAST_SAID_CHARS) return flat;
  const cut = flat.slice(0, MOST_LAST_SAID_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
}

function workingNow(row: SessionRow): boolean {
  return row.turn === 'in progress' || row.state === 'working';
}

/** As many cards as the switcher turns through before it is a list nobody can follow. */
const MOST_CARDS = 7;

type Names = Awaited<ReturnType<typeof readNames>>;

function nameOf(names: Names, agent: string): string {
  const id = agent.startsWith(AGENT_ID_PREFIX) ? agent : `${AGENT_ID_PREFIX}${agent}`;
  return displayName(names, { id, kind: agent });
}

function cardOf(row: SessionRow, names: Names, host: SessionHost | null): SessionCard {
  const repository = row.repositories[0];
  return {
    sessionId: row.session,
    agent: row.agent,
    agentName: nameOf(names, row.agent),
    state: row.state,
    thinking: row.turn === 'in progress',
    ...(row.task === undefined ? {} : { task: row.task }),
    ...(repository === undefined ? {} : { repository: basename(repository) }),
    ...(row.runningIn === undefined ? {} : { runningIn: row.runningIn }),
    ...(row.where === undefined ? {} : { where: row.where }),
    ...(row.lastActive === undefined ? {} : { lastActive: row.lastActive }),
    ...(row.actions === undefined ? {} : { actions: row.actions }),
    ...(row.started === undefined || row.started === ''
      ? {}
      : { startedAt: row.started }),
    ...(host === null ? {} : { host: hostOf(host) }),
  };
}

/** What view gathered beside the session's row, for viewOf to lay out. */
interface Gathered {
  sessionId: string;
  agentName: string;
  steps: SessionViewStep[];
  code: Code;
  task: string | undefined;
  repository: string | undefined;
  branch: string | null;
  lastSaid: string | null;
  /** The person's latest words from the transcript; null when it holds none, undefined when there is none to read. */
  latestAsk: string | null | undefined;
  conversation: { conversation?: ConversationLine[] };
}

function viewOf(row: SessionRow, gathered: Gathered): SessionView {
  const { sessionId, agentName, steps, code, task, repository, branch, lastSaid } =
    gathered;
  const lastAsk = latestAskOf(row, gathered.latestAsk);
  return {
    sessionId,
    agent: row.agent,
    agentName,
    state: row.state,
    thinking: row.turn === 'in progress',
    waitingOnYou: row.waitingOnYou,
    helpers: helpersOf(row),
    steps,
    files: code.files,
    ...(code.excerpt === undefined ? {} : { excerpt: code.excerpt }),
    ...(task === undefined ? {} : { task }),
    ...(lastAsk === undefined || lastAsk === task ? {} : { lastAsk }),
    ...(repository === undefined ? {} : { repository: basename(repository) }),
    ...(branch === null ? {} : { branch }),
    ...(row.runningIn === undefined ? {} : { runningIn: row.runningIn }),
    ...(row.where === undefined ? {} : { where: row.where }),
    ...(lastSaid === null ? {} : { lastSaid: clipped(lastSaid) }),
    ...(row.started === undefined || row.started === ''
      ? {}
      : { startedAt: row.started }),
    ...(row.lastActive === undefined ? {} : { lastActive: row.lastActive }),
    ...(row.paused === undefined ? {} : { paused: row.paused }),
    ...gathered.conversation,
  };
}

/** The transcript's word over the prompt hook's, since the hook cannot tell the person's prompt from a helper's report. */
function latestAskOf(
  row: SessionRow,
  fromTranscript: string | null | undefined,
): string | undefined {
  if (fromTranscript === undefined) return row.lastAsk;
  if (fromTranscript === null) return undefined;
  const statement = statementOfPrompt(fromTranscript);
  return statement === '' ? undefined : statement;
}

function hostOf(host: SessionHost): DisplayHost {
  return {
    ...(host.app === undefined ? {} : { app: host.app }),
    ...(host.appPath === undefined ? {} : { appPath: host.appPath }),
    ...(host.tty === undefined ? {} : { tty: host.tty }),
    ...(host.cwd === undefined ? {} : { cwd: host.cwd }),
    ...conversationOf(host),
  };
}

/** What a session changed: its files, and the changed lines of the one it changed most. */
interface Code {
  files: CardFile[];
  excerpt?: CardExcerpt;
}

const SEAMS: RewindSeams = {
  build: (place) => new Milestones(new NodeGit(place), new NodeWorktree(place)),
  unattended: () => true,
  terminal: () => false,
  confirm: async () => null,
};

function stepOf(step: ReplayStep): SessionViewStep {
  const target = step.target === undefined ? '' : ` ${shortTarget(step.target)}`;
  const text =
    step.operation === DELIVERY_OPERATION
      ? deliveredAs(step.target)
      : `${verbOf(step.operation) ?? step.summary}${target}`;
  return {
    at: step.at,
    surface: step.surface ?? 'action',
    text:
      text.length <= MOST_STEP_CHARS ? text : `${text.slice(0, MOST_STEP_CHARS - 1)}…`,
    ...(step.failed === true ? { failed: true } : {}),
    ...(step.effect === DECISION_EFFECT.DENY ? { refused: true } : {}),
  };
}

/** The ledger's operations as a person reads them down a list. */
const VERBS: Record<string, string> = {
  'file.edit': 'Edited',
  'file.read': 'Read',
  'filesystem.read': 'Read',
  'filesystem.write': 'Wrote in',
  'filesystem.delete': 'Deleted',
  'shell.exec': 'Ran',
  'http.request': 'Fetched',
  'http.connect': 'Connected to',
  'git.commit': 'Committed',
  'git.push': 'Pushed',
  'git.pull': 'Pulled',
  'git.checkout': 'Switched to',
  'session.summary': 'Finished its turn',
};

/** What became of the person's own words to the session, said as they would say it rather than as the ledger's row. */
const DELIVERED: Record<string, string> = {
  [DELIVERY.VERIFIED]: 'Your message went in',
  [DELIVERY.TYPED]: 'Your message was typed in',
  [DELIVERY.WAITING]: 'Your message waits for its next prompt',
  [DELIVERY.CLIPBOARD]: 'Your message was left on the clipboard',
  [DELIVERY.NOT_ALLOWED]: 'Your message was left on the clipboard',
  [DELIVERY.FAILED]: 'Your message did not go in',
};

export function deliveredAs(outcome: string | undefined): string {
  return (
    (outcome === undefined ? undefined : DELIVERED[outcome]) ?? 'You sent it a message'
  );
}

function verbOf(operation: string | undefined): string | undefined {
  if (operation === undefined) return undefined;
  return VERBS[operation] ?? operation.replace(/[._]/g, ' ');
}

/** A path by its last two parts, which is how a file is recognised at a glance. */
function shortTarget(target: string): string {
  if (!isAbsolute(target) && !target.startsWith('../')) return target;
  return normalize(target)
    .split('/')
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .slice(-2)
    .join('/');
}

function helpersOf(row: SessionRow): string[] {
  const working = row.subagents?.working ?? [];
  return working.map((each) =>
    [
      each.type ?? 'A helper',
      each.lastTool === undefined ? 'working' : `using ${each.lastTool}`,
    ].join(' '),
  );
}
