/**
 * A line-delimited JSON protocol over a Unix socket, kept small because an interceptor
 * asks on every command an agent types, so asking has to cost a connect and one line.
 */
import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import type { DecisionEffect } from '../constants/decision.constants';

export const SOCKET_FILE = 'memnox.sock';

export function socketPathFor(home: string): string {
  return join(home, MEMNOX_HOME, SOCKET_FILE);
}

export const DAEMON_METHOD = {
  /** Rule on one action. The hot path, and the only one with a latency budget. */
  EVALUATE: 'evaluate',
  /** Ask a person, through whatever terminal the daemon owns. */
  HOLD: 'hold',
  /** Record how a command ended, so a session is one timeline and the breaker can count outcomes. */
  RECORD: 'record',
  /** Whether this session is held, asked before anything runs. */
  STATUS: 'status',
  /** Liveness, for `memnox doctor`. */
  PING: 'ping',
  /** Keeps the connection open and writes one line per thing that starts waiting on a person. */
  SUBSCRIBE: 'subscribe',
  /** What is waiting on a person right now: held calls and proposals. */
  WAITING: 'waiting',
  /** A person's answer to a held call or a proposal; anything but a refusal carries a signature. */
  CONFIRM: 'confirm',
  /** The public half of the key a confirmation is signed with, trusted on first use. */
  REGISTER_KEY: 'register-key',
  /** What the person said, answered by their own agent CLI one chunk per line as it streams. */
  ASK: 'ask',
  /** Stops the answer in flight, usually because the person started talking over it. */
  CANCEL: 'cancel',
  /** Where a session's agent is on screen, so the Mac app can bring that window forward. */
  LOCATE: 'locate',
  /** Something happened rather than was asked: the brain says it, streamed like ASK. */
  BRIEF: 'brief',
} as const;

export type DaemonMethod = (typeof DAEMON_METHOD)[keyof typeof DAEMON_METHOD];

export interface DaemonRequest {
  id: number;
  method: DaemonMethod;
  sessionId?: string;
  agent?: string;
  action?: string;
  target?: string;
  /** A digest. Arguments never travel, not even over a local socket. */
  argsDigest?: string;
  reason?: string;
  /** On RECORD: how the command ended. The breaker's error and progress signals. */
  exitCode?: number;
  /** On RECORD: whether it fell outside the declared task. */
  outOfScope?: boolean;
  /** On RECORD: only the drift is being reported, so nothing is charged or counted as done. */
  driftOnly?: boolean;
  /** On RECORD: what it cost, when a surface can report one. Never estimated. */
  costUsd?: number;
  /** On CONFIRM: the held call or proposal being answered. */
  subject?: string;
  /** On CONFIRM: a hold answer for a held call, or confirmed / declined for a proposal. */
  answer?: string;
  /** On CONFIRM: base64 DER ECDSA over the confirmation message. Absent on a refusal. */
  signature?: string;
  /** On REGISTER_KEY: the base64 X9.63 P-256 point. */
  point?: string;
  /** On ASK: what the person said, whole, in their own words. */
  said?: string;
  /** On any voice request: the name the person asked to be called. */
  owner?: string;
  /** On BRIEF: held, paused or back. */
  briefing?: string;
  /** On BRIEF back: when the person went away. */
  since?: string;
}

export const BRIEFING = {
  /** A held call, told with what its session has been doing. */
  HELD: 'held',
  /** A session the breaker stopped. */
  PAUSED: 'paused',
  /** The person came back to their Mac. */
  BACK: 'back',
} as const;

/** Where a session runs, as LOCATE answers it. */
export interface DaemonLocation {
  sessionId: string;
  agent: string;
  /** False once the agent's process has ended, so nothing is shown that is gone. */
  alive: boolean;
  app?: string;
  appPath?: string;
  tty?: string;
  cwd?: string;
}

/** Kinds an ASK chunk ends a turn with; anything else is more of the same turn. */
export const ASK_ENDS: readonly string[] = ['done', 'limited', 'failed', 'cancelled'];

/** One piece of an answer: words to speak, a tool being read, or how the turn ended. */
export interface DaemonAskChunk {
  kind: string;
  text?: string;
  tool?: string;
}

export const DAEMON_EVENT = {
  /** A call is held until a person answers it. */
  HELD: 'held',
  /** Something suggested a change a person has to confirm. */
  PROPOSAL: 'proposal',
  /** The breaker stopped a session. */
  PAUSED: 'paused',
  /** Something told before is no longer waiting: answered elsewhere, or expired. */
  SETTLED: 'settled',
} as const;

export type DaemonEventKind = (typeof DAEMON_EVENT)[keyof typeof DAEMON_EVENT];

/** One thing a person may want to hear about, in words that can be spoken as they are. */
export interface DaemonEvent {
  kind: DaemonEventKind;
  /** The id a CONFIRM names: a pending id, a proposal id, or the session that paused. */
  subject: string;
  agent: string;
  summary: string;
  at: string;
  expiresAt?: string;
  /** On HELD, the facts a person hears, so the voice words them rather than reading a line. */
  agentName?: string;
  /** What it wants to do, as a phrase: "push to main". */
  what?: string;
  /** Why it was held rather than run. */
  why?: string;
  /** The task the session was given, in the person's words. */
  task?: string;
  /** The folder the session works in, by name. */
  place?: string;
}

export interface DaemonResponse {
  id: number;
  ok: boolean;
  effect?: DecisionEffect;
  reason?: string;
  alternative?: { action: string; resource?: string; note: string };
  /** Set when a limit stopped this rather than a rule. */
  limit?: string;
  /** Set when the breaker held the session. Different from a denial, and said so. */
  paused?: { signal: string; reason: string };
  /** On SUBSCRIBE, one per line after the first acknowledgement. */
  event?: DaemonEvent;
  /** On WAITING. */
  waiting?: readonly DaemonEvent[];
  /** On LOCATE. */
  location?: DaemonLocation;
  /** On ASK, one per line; the turn ends with a chunk whose kind is in ASK_ENDS. */
  chunk?: DaemonAskChunk;
  /** On CONFIRM and REGISTER_KEY: what happened, in a word or two. */
  outcome?: string;
  error?: string;
}

export function encode(message: DaemonRequest | DaemonResponse): string {
  return `${JSON.stringify(message)}\n`;
}

/** Null rather than a throw: a garbled line is a bad client, not a crash. */
export function decodeRequest(line: string): DaemonRequest | null {
  const message = parseMessage<DaemonRequest>(line);
  if (message === null || typeof message.method !== 'string') return null;
  // The id and method are checked; the rest is optional by the protocol's own shape.
  return message as DaemonRequest;
}

export function decodeResponse(line: string): DaemonResponse | null {
  const message = parseMessage<DaemonResponse>(line);
  // Only the id is required; every other field of a response is optional.
  return message === null ? null : (message as DaemonResponse);
}

/** An object carrying a numeric id, or null for anything else, including a line that is not JSON. */
function parseMessage<T extends { id: number }>(line: string): Partial<T> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  // Narrowed field by field by the callers, starting with the id here.
  const message = parsed as Partial<T>;
  return typeof message.id === 'number' ? message : null;
}
