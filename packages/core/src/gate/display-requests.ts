import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import type {
  AgentNode,
  CardExcerpt,
  TraceCard,
  CardFile,
  Delivery,
  DisplayKind,
  WalkPage,
} from '../daemon/protocol';
import { shortDigest } from '../domain/digest';
import { JsonRecordDir } from '../store/json-records';

/**
 * A request from the operator to show the person something: a session's window, or a card
 * with its summary. It changes nothing an agent can do, so it needs no confirmation, and it
 * expires quickly because a window that opens a minute after it was asked for is a surprise.
 */

export const DISPLAYS_DIR = 'displays';

/** Long enough for the app to pick it up, short enough that a late one is dropped. */
export const DISPLAY_TTL_MS = 30_000;

/** A card says a summary; a page of text is not one. */
export const DISPLAY_TEXT_LIMIT = 600;

/** As many files as a card can list and still be read at a glance. */
export const CARD_FILES = 6;
/** A handful of changed lines, enough to see what the change is. */
export const CARD_LINES = 12;
/** A walk through covers the files that matter, never every file a session touched. */
export const WALK_PAGES = 5;
/** As many agents as fit around the middle of a screen and can still each be read. */
export const SCAN_AGENTS = 12;
/** As many steps as a card shows before it is a log rather than a picture. */
export const TRACE_ROWS = 16;

export interface DisplayRequest {
  id: string;
  display: DisplayKind;
  sessionId: string;
  agent: string;
  title: string;
  text?: string;
  /** The session's folder, for when where it runs on screen was never noted. */
  cwd?: string;
  files?: CardFile[];
  excerpt?: CardExcerpt;
  pages?: WalkPage[];
  agents?: AgentNode[];
  trace?: TraceCard;
  requestedAt: string;
  expiresAt: string;
  /** Set once the Mac says how typing it ended; a delivered request is never shown again. */
  delivered?: DisplayDelivery;
}

/** What the Mac said became of an instruction it was asked to type. */
export interface DisplayDelivery {
  outcome: Delivery;
  at: string;
  /** In the Mac's words, when it could say why it could not. */
  reason?: string;
}

export interface DisplayInput {
  display: DisplayKind;
  sessionId: string;
  agent: string;
  title: string;
  text?: string;
  cwd?: string;
  files?: CardFile[];
  excerpt?: CardExcerpt;
  pages?: WalkPage[];
  agents?: AgentNode[];
  trace?: TraceCard;
  at: string;
}

export class DisplayRequests {
  private readonly records: JsonRecordDir<DisplayRequest>;

  constructor(home: string) {
    this.records = new JsonRecordDir(join(home, MEMNOX_HOME, DISPLAYS_DIR));
  }

  async request(input: DisplayInput): Promise<DisplayRequest> {
    const text = input.text?.slice(0, DISPLAY_TEXT_LIMIT);
    const request: DisplayRequest = {
      id: `dsp_${Date.parse(input.at).toString(36)}_${shortDigest(`${input.sessionId}${input.display}${input.title}`)}`,
      display: input.display,
      sessionId: input.sessionId,
      agent: input.agent,
      title: input.title,
      ...(text === undefined ? {} : { text }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.files === undefined ? {} : { files: input.files.slice(0, CARD_FILES) }),
      ...(input.excerpt === undefined
        ? {}
        : {
            excerpt: {
              path: input.excerpt.path,
              lines: input.excerpt.lines.slice(0, CARD_LINES),
            },
          }),
      ...(input.pages === undefined
        ? {}
        : {
            pages: input.pages.slice(0, WALK_PAGES).map((page) => ({
              ...page,
              note: page.note.slice(0, DISPLAY_TEXT_LIMIT),
              lines: page.lines.slice(0, CARD_LINES),
            })),
          }),
      ...(input.agents === undefined
        ? {}
        : { agents: input.agents.slice(0, SCAN_AGENTS) }),
      ...(input.trace === undefined
        ? {}
        : { trace: { ...input.trace, rows: input.trace.rows.slice(0, TRACE_ROWS) } }),
      requestedAt: input.at,
      expiresAt: new Date(Date.parse(input.at) + DISPLAY_TTL_MS).toISOString(),
    };
    await this.records.write(request.id, request);
    return request;
  }

  /** Only what has not expired, oldest first, removing what has so the folder never grows. */
  async open(moment: string): Promise<DisplayRequest[]> {
    const found = await this.records.all();
    for (const each of found) {
      if (each.expiresAt <= moment) await this.records.remove(each.id);
    }
    return found
      .filter((each) => each.expiresAt > moment && each.delivered === undefined)
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  /** The Mac's word on a request, false when it is gone, since a late answer has nobody waiting on it. */
  async deliver(id: string, delivery: DisplayDelivery): Promise<boolean> {
    const request = await this.records.read(id);
    if (request === null) return false;
    await this.records.write(id, { ...request, delivered: delivery });
    return true;
  }

  async deliveryOf(id: string): Promise<DisplayDelivery | null> {
    return (await this.records.read(id))?.delivered ?? null;
  }
}
