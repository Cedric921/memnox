/**
 * A held question answered in Claude Code's own picker. The agent opens it and the host
 * fills in the pick, but the agent can also send the picker with its answer already filled
 * in and the host passes that through unseen, so only a picker seen opening empty counts.
 */
import { join } from 'node:path';

import {
  answeredText,
  heldIdsIn,
  JsonRecordDir,
  markTold,
  MEMNOX_HOME,
  openInSession,
  PendingApprovals,
  replyOf,
  UNNAMED_SESSION,
  type PendingApproval,
} from '@memnox/core';

import { EDIT_HOOK_EVENT } from './edit-hook';
import { fieldsOf } from './hook-payload';

const PICKER_TOOL = 'AskUserQuestion';

const PICKERS_DIR = 'pickers';

/** A picker seen opening with nothing filled in, so its answer is the person's. */
interface OpenedPicker {
  sessionId: string;
  heldIds: string[];
  openedAt: string;
}

export interface PickerContext {
  home: string;
  runSession: string | undefined;
  now: () => Date;
  person: () => string;
}

/** What the hook says about a picker, or null where it is not one asking a held question. */
interface PickerAnswer {
  stdout?: string;
}

const REFUSED =
  'Memnox: a held question is answered by your person, so it goes to them with no answer filled in. Ask again with the same question and options and leave answers empty.';

interface PickerQuestion {
  question: string;
}

function questionsOf(input: unknown): PickerQuestion[] {
  const questions = fieldsOf(input)?.['questions'];
  if (!Array.isArray(questions)) return [];
  const found: PickerQuestion[] = [];
  for (const each of questions) {
    const fields = fieldsOf(each);
    const question = fields?.['question'];
    if (typeof question === 'string') found.push({ question });
  }
  return found;
}

/** Answers keyed by question text, the way the host records a pick. */
function answersOf(value: unknown): Record<string, string> {
  const answers = fieldsOf(value)?.['answers'];
  const fields = fieldsOf(answers);
  if (fields === null) return {};
  const kept: Record<string, string> = {};
  for (const [question, label] of Object.entries(fields)) {
    if (typeof label === 'string') kept[question] = label;
  }
  return kept;
}

function pickersFor(home: string): JsonRecordDir<OpenedPicker> {
  return new JsonRecordDir(join(home, MEMNOX_HOME, PICKERS_DIR));
}

/** A tool use id is the host's, but it is still a file name, so nothing in it can climb out. */
function recordId(toolUseId: string): string {
  return toolUseId.replace(/[^\w.-]/g, '_');
}

/** The held questions a picker asks that are still open in this session, with where it runs. */
interface Asking {
  hook: Record<string, unknown>;
  toolUseId: string;
  sessionId: string;
  moment: string;
  approvals: PendingApprovals;
  open: PendingApproval[];
  questions: PickerQuestion[];
}

async function askingIn(
  payload: unknown,
  context: PickerContext,
): Promise<Asking | null> {
  const hook = fieldsOf(payload);
  if (hook === null || hook['tool_name'] !== PICKER_TOOL) return null;
  const toolUseId = hook['tool_use_id'];
  if (typeof toolUseId !== 'string' || toolUseId === '') return null;
  const hostSession = typeof hook['session_id'] === 'string' ? hook['session_id'] : '';
  const sessionId =
    context.runSession ?? (hostSession === '' ? UNNAMED_SESSION : hostSession);
  const moment = context.now().toISOString();
  const approvals = new PendingApprovals(context.home);
  const open = await openInSession(approvals, sessionId, moment);
  const openIds = new Set(open.map((each) => each.id.toLowerCase()));
  const questions = questionsOf(hook['tool_input']).filter((each) =>
    heldIdsIn(each.question).some((id) => openIds.has(id)),
  );
  if (questions.length === 0) return null;
  return { hook, toolUseId, sessionId, moment, approvals, open, questions };
}

/**
 * Before the picker opens: one already answered is refused, and one asking a held question
 * with nothing filled in is written down. After: the pick is the answer, from that one only.
 */
export async function answerPicker(
  payload: unknown,
  context: PickerContext,
): Promise<PickerAnswer | null> {
  const asking = await askingIn(payload, context);
  if (asking === null) return null;
  const event = asking.hook['hook_event_name'];
  if (event === EDIT_HOOK_EVENT.PRE_TOOL_USE) return opening(asking, context.home);
  if (event !== EDIT_HOOK_EVENT.POST_TOOL_USE) return null;

  const pickers = pickersFor(context.home);
  const opened = await pickers.read(recordId(asking.toolUseId));
  // Never seen opening empty, so whatever it carries could be the agent's own answer.
  if (opened === null || opened.sessionId !== asking.sessionId) return {};
  await pickers.remove(recordId(asking.toolUseId));
  const told = await recordPicks(asking, opened, context.person());
  if (told.length === 0) return {};
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: EDIT_HOOK_EVENT.POST_TOOL_USE,
        additionalContext: told.join('\n'),
      },
    }),
  };
}

/** Each pick written as that question's answer, and what the agent is told of it. */
async function recordPicks(
  asking: Asking,
  opened: OpenedPicker,
  person: string,
): Promise<string[]> {
  const picked = answersOf(asking.hook['tool_response']);
  const told: string[] = [];
  for (const each of asking.questions) {
    const label = picked[each.question];
    if (label === undefined) continue;
    for (const id of heldIdsIn(each.question)) {
      if (!opened.heldIds.includes(id)) continue;
      const reply = replyOf(`${label} ${id}`, asking.open);
      if (reply === null) continue;
      const { approvals, moment } = asking;
      const outcome = await approvals.answer(reply.id, reply.answer, person, moment);
      if (outcome === null || !('answered' in outcome)) continue;
      await markTold(approvals, [outcome.answered], moment);
      told.push(answeredText(outcome.answered));
    }
  }
  return told;
}

async function opening(asking: Asking, home: string): Promise<PickerAnswer> {
  if (Object.keys(answersOf(asking.hook['tool_input'])).length > 0) {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: EDIT_HOOK_EVENT.PRE_TOOL_USE,
          permissionDecision: 'deny',
          permissionDecisionReason: REFUSED,
        },
      }),
    };
  }
  await pickersFor(home).write(recordId(asking.toolUseId), {
    sessionId: asking.sessionId,
    heldIds: asking.questions.flatMap((each) => heldIdsIn(each.question)),
    openedAt: asking.moment,
  });
  return {};
}
