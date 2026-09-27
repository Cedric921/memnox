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
  pickedAnswer,
  pickerOptions,
  pickerQuestion,
  UNNAMED_SESSION,
  type PendingApproval,
  type PickerOption,
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

const REWORDED =
  'Memnox: a held question goes to your person exactly as Memnox worded it, one held id per question, with exactly its three options and no other descriptions. Ask again word for word as Memnox told you.';

const REFUSED =
  'Memnox: a held question is answered by your person, so it goes to them with no answer filled in. Ask again with the same question and options and leave answers empty.';

interface PickerQuestion {
  question: string;
  options: PickerOption[];
  multiSelect: boolean;
}

function questionsOf(input: unknown): PickerQuestion[] {
  const questions = fieldsOf(input)?.['questions'];
  if (!Array.isArray(questions)) return [];
  const found: PickerQuestion[] = [];
  for (const each of questions) {
    const fields = fieldsOf(each);
    const question = fields?.['question'];
    if (typeof question !== 'string') continue;
    found.push({
      question,
      options: optionsOf(fields?.['options']),
      multiSelect: fields?.['multiSelect'] === true,
    });
  }
  return found;
}

function optionsOf(value: unknown): PickerOption[] {
  if (!Array.isArray(value)) return [];
  const found: PickerOption[] = [];
  for (const each of value) {
    const fields = fieldsOf(each);
    const label = fields?.['label'];
    const description = fields?.['description'];
    if (typeof label !== 'string') continue;
    found.push(
      typeof description === 'string' && description !== ''
        ? { label, description }
        : { label },
    );
  }
  return found;
}

/**
 * The held call a question asks about, where it is worded exactly as Memnox wrote it for
 * one call and offers exactly Memnox's options. The agent types both, so anything else,
 * a reworded question, a second id, a relabelled option, answers nothing.
 */
function heldCallAsked(
  question: PickerQuestion,
  open: readonly PendingApproval[],
): PendingApproval | null {
  const ids = heldIdsIn(question.question);
  if (ids.length !== 1 || question.multiSelect) return null;
  const held = open.find((each) => each.id.toLowerCase() === ids[0]);
  if (held === undefined || question.question !== pickerQuestion(held)) return null;
  const wanted = pickerOptions(held);
  const same =
    question.options.length === wanted.length &&
    question.options.every(
      (option, at) =>
        option.label === wanted[at]?.label &&
        option.description === wanted[at]?.description,
    );
  return same ? held : null;
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

/** The held questions a picker asks, in this session, answered or not, with where it runs. */
interface Asking {
  hook: Record<string, unknown>;
  toolUseId: string;
  sessionId: string;
  moment: string;
  approvals: PendingApprovals;
  open: PendingApproval[];
  questions: PickerQuestion[];
  /** Already answered, from a DM mostly, so the picker has nothing left to ask. */
  settled: PendingApproval[];
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
  const questions = questionsOf(hook['tool_input']);
  const held = await heldIn(approvals, questions, sessionId);
  if (held.length === 0) return null;
  const open = await openInSession(approvals, sessionId, moment);
  const settled = held.filter((each) => each.answer !== undefined);
  return { hook, toolUseId, sessionId, moment, approvals, open, questions, settled };
}

/** Every held question the picker names that belongs to this session. */
async function heldIn(
  approvals: PendingApprovals,
  questions: readonly PickerQuestion[],
  sessionId: string,
): Promise<PendingApproval[]> {
  const found = new Map<string, PendingApproval>();
  for (const id of questions.flatMap((each) => heldIdsIn(each.question))) {
    const pending = await approvals.read(id).catch(() => null);
    if (pending?.request.sessionId === sessionId) found.set(id, pending);
  }
  return [...found.values()];
}

/** What both sides are told of an answer that arrived before the picker could give one. */
function settledReply(event: string, settled: readonly PendingApproval[]): string {
  const told = settled.map(answeredText).join('\n');
  const seen = settled.map(
    (each) => `${each.answeredBy ?? 'somebody'} already answered this`,
  );
  const shown = `Memnox: ${seen.join('; ')}, so a pick here is not needed and is not used.`;
  if (event === EDIT_HOOK_EVENT.PRE_TOOL_USE)
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: 'deny',
        permissionDecisionReason: `Memnox: this was already answered, so do not ask it. ${told}`,
      },
      systemMessage: shown,
    });
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: told },
    systemMessage: shown,
  });
}

/**
 * Before the picker opens: one already answered is refused, and one asking a held question
 * with nothing filled in is written down. After: the pick is the answer, from that one only,
 * unless another answer got there first, which then stands and is said to both sides.
 */
export async function answerPicker(
  payload: unknown,
  context: PickerContext,
): Promise<PickerAnswer | null> {
  const asking = await askingIn(payload, context);
  if (asking === null) return null;
  const event = asking.hook['hook_event_name'];
  if (event !== EDIT_HOOK_EVENT.PRE_TOOL_USE && event !== EDIT_HOOK_EVENT.POST_TOOL_USE)
    return null;
  if (asking.settled.length > 0) {
    await markTold(asking.approvals, asking.settled, asking.moment);
    await pickersFor(context.home).remove(recordId(asking.toolUseId));
    return { stdout: settledReply(event, asking.settled) };
  }
  if (event === EDIT_HOOK_EVENT.PRE_TOOL_USE) return opening(asking, context.home);

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
    const held = heldCallAsked(each, asking.open);
    const label = picked[each.question];
    if (held === null || label === undefined) continue;
    if (!opened.heldIds.includes(held.id.toLowerCase())) continue;
    const answer = pickedAnswer(label);
    if (answer === null) {
      told.push(
        `Memnox: they did not pick one of the three choices for ${held.id}, so nothing was answered. If they said what they want instead, do that; otherwise ask again.`,
      );
      continue;
    }
    const { approvals, moment } = asking;
    const outcome = await approvals.answer(held.id, answer, person, moment);
    if (outcome === null || !('answered' in outcome)) continue;
    await markTold(approvals, [outcome.answered], moment);
    told.push(answeredText(outcome.answered));
  }
  return told;
}

function refusing(reason: string): PickerAnswer {
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: EDIT_HOOK_EVENT.PRE_TOOL_USE,
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  };
}

async function opening(asking: Asking, home: string): Promise<PickerAnswer> {
  if (Object.keys(answersOf(asking.hook['tool_input'])).length > 0)
    return refusing(REFUSED);
  const asked = asking.questions.filter((each) => heldIdsIn(each.question).length > 0);
  const held = asked.map((each) => heldCallAsked(each, asking.open));
  if (held.some((each) => each === null)) return refusing(REWORDED);
  await pickersFor(home).write(recordId(asking.toolUseId), {
    sessionId: asking.sessionId,
    heldIds: held.flatMap((each) => (each === null ? [] : [each.id.toLowerCase()])),
    openedAt: asking.moment,
  });
  return {};
}
