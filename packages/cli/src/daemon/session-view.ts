import { basename, isAbsolute, normalize } from 'node:path';
import {
  AGENT_ID_PREFIX,
  buildReplay,
  DECISION_EFFECT,
  LEDGER_SESSION_LIMIT,
  Milestones,
  NodeGit,
  NodeWorktree,
  REPLAY_STEP,
  SessionHosts,
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
import { changesTool } from '../session-tools/changes-tool';
import type { SessionToolDeps } from '../session-tools/read-tools';
import type { RewindSeams } from '../session-tools/rewind-tool';
import { SESSION_STATE, sessionsTool } from '../session-tools/sessions-tool';
import { excerptOf, type ChangedFile } from '../session-tools/show-tool';
import { readConversation, readLastAnswer, sessionTranscript } from './transcript';
import { conversationOf } from './waiting-feed';
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

/** Enough steps to see what it is in the middle of, never a log to scroll. */
const MOST_STEPS = 12;
const MOST_FILES = 8;
/** As long a command line as a window row shows before it is cut. */
const MOST_STEP_CHARS = 90;
/** The window polls every couple of seconds, and a diff of the tree is not that cheap. */
const FILES_FRESH_MS = 8_000;

interface SessionRow {
  session: string;
  agent: string;
  task?: string;
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

export class SessionViews {
  private readonly files = new Map<string, { at: number; code: Code }>();

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
    const hermes = hermesCards(this.transcripts, this.now(), nameOf(names, 'hermes'));
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
    const [steps, { files, excerpt }, names] = await Promise.all([
      this.steps(sessionId),
      this.changed(deps, sessionId),
      readNames(this.home),
    ]);
    const repository = row.repositories[0];
    return {
      sessionId,
      agent: row.agent,
      agentName: nameOf(names, row.agent),
      state: row.state,
      thinking: row.turn === 'in progress',
      waitingOnYou: row.waitingOnYou,
      helpers: helpersOf(row),
      steps,
      files,
      ...(excerpt === undefined ? {} : { excerpt }),
      ...(row.task === undefined ? {} : { task: row.task }),
      ...(repository === undefined ? {} : { repository: basename(repository) }),
      ...(row.runningIn === undefined ? {} : { runningIn: row.runningIn }),
      ...(row.started === undefined || row.started === ''
        ? {}
        : { startedAt: row.started }),
      ...(row.lastActive === undefined ? {} : { lastActive: row.lastActive }),
      ...(row.paused === undefined ? {} : { paused: row.paused }),
      ...(await this.conversation(sessionId)),
    };
  }

  /** What the agent said to end its latest turn, in full, for the voice to answer "what did it find". */
  async lastAnswer(sessionId: string): Promise<string | null> {
    if (isHermesSession(sessionId)) return hermesLastAnswer(this.transcripts, sessionId);
    const path = await sessionTranscript(this.home, sessionId, this.transcripts);
    return path === null ? null : readLastAnswer(path);
  }

  /** What was said, read from the agent's own transcript, or nothing where it keeps none Memnox can read. */
  private async conversation(
    sessionId: string,
  ): Promise<{ conversation?: ConversationLine[] }> {
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

  /** The files it changed and the lines of the busiest, kept a few seconds, since every poll would otherwise diff the tree. */
  private async changed(deps: SessionToolDeps, sessionId: string): Promise<Code> {
    const kept = this.files.get(sessionId);
    const moment = this.now().getTime();
    if (kept !== undefined && moment - kept.at < FILES_FRESH_MS) return kept.code;
    const answer = await changesIn(deps, sessionId);
    const shown = answer.files?.shown ?? [];
    const others = await Promise.all(
      (answer.alsoChanged ?? []).map((each) =>
        changesIn(deps, sessionId, each.repository),
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

/** What changes says a session changed, in one repository or the one it wrote in last. */
interface Changes {
  repository?: string;
  files?: { shown: ChangedFile[] };
  alsoChanged?: { repository: string }[];
}

async function changesIn(
  deps: SessionToolDeps,
  sessionId: string,
  repository?: string,
): Promise<Changes> {
  const args =
    repository === undefined
      ? { session: sessionId }
      : { session: sessionId, repository };
  // Shaped by changesTool itself, and a failure is a session with nothing to show.
  return (await changesTool(deps, SEAMS, args).catch(() => ({}))) as Changes;
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
  const text = `${verbOf(step.operation) ?? step.summary}${target}`;
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
