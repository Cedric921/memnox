import { minutesToMs, readJsonFile, writeJsonFile } from '@memnox/core';
import { conversationPath } from '../memnox-paths';

/**
 * Which brain conversation the voice is in, so "and the other one?" a few minutes later
 * resumes it with its context rather than starting a stranger.
 */

/** Long enough for a coffee between questions, short enough that tomorrow starts fresh. */
const CONVERSATION_IDLE_MS = minutesToMs(30);

interface Conversation {
  brain: string;
  sessionId: string;
  lastAt: string;
  /** Which instructions and model it began under, since history written under old ones teaches the old way. */
  version?: string;
}

export class Conversations {
  constructor(private readonly home: string) {}

  /** The conversation to resume, or null when there is none for this brain or it went quiet. */
  async resumable(brain: string, now: Date, version: string): Promise<string | null> {
    const kept = await readJsonFile<Conversation>(conversationPath(this.home));
    if (kept === null || kept.brain !== brain || kept.version !== version) return null;
    const idle = now.getTime() - Date.parse(kept.lastAt);
    return idle < CONVERSATION_IDLE_MS ? kept.sessionId : null;
  }

  async keep(
    brain: string,
    sessionId: string,
    now: Date,
    version: string,
  ): Promise<void> {
    const kept: Conversation = { brain, sessionId, lastAt: now.toISOString(), version };
    await writeJsonFile(conversationPath(this.home), kept);
  }
}
