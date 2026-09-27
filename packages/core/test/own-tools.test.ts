import { describe, expect, it } from 'vitest';
import { classifyTool, TOOL_CLASS } from '../src/discovery/classify';
import {
  ownToolDeclaration,
  SESSION_SERVER_NAME,
  WORKSPACE_SERVER_NAME,
  toolDeclarations,
} from '../src/discovery/own-tools';
import type { EnvironmentSnapshot } from '../src/discovery/snapshot';
import { classifyToolCall } from '../src/intercept/tool-call';

const snapshot = (servers: EnvironmentSnapshot['servers']): EnvironmentSnapshot => ({
  takenAt: '2026-09-27T00:00:00.000Z',
  agents: [],
  servers,
  resources: [],
});

const server = (
  name: string,
  tools: EnvironmentSnapshot['servers'][number]['tools'],
) => ({
  name,
  grantedBy: '/tmp/.claude.json',
  agentIds: [],
  tools,
});

describe("Memnox's own tools", () => {
  it.each([
    ['memnox_rules_in_force', TOOL_CLASS.READ],
    ['memnox_boundary', TOOL_CLASS.READ],
    ['memnox_check_approval', TOOL_CLASS.READ],
    ['memnox_memory', TOOL_CLASS.READ],
    ['memnox_context', TOOL_CLASS.READ],
    ['memnox_people', TOOL_CLASS.READ],
    ['memnox_workspace', TOOL_CLASS.READ],
    ['memnox_sources', TOOL_CLASS.READ],
    ['memnox_report_action', TOOL_CLASS.WRITE],
    ['memnox_request_approval', TOOL_CLASS.WRITE],
    ['memnox_hold_path', TOOL_CLASS.WRITE],
    ['memnox_release_path', TOOL_CLASS.WRITE],
  ])(
    'classes the workspace tool %s as %s from its name on its own server',
    (name, expected) => {
      expect(
        classifyToolCall(name, {}, ownToolDeclaration(WORKSPACE_SERVER_NAME, name)).class,
      ).toBe(expected);
    },
  );

  /* A lookalike on another server took Memnox's annotations by name, so a
     `memnox_memory` that deletes was classed as a read. */
  it('gives a lookalike on any other server nothing from the name', () => {
    expect(ownToolDeclaration('evil', 'memnox_memory')).toBeUndefined();
    expect(classifyTool({ name: 'memnox_memory' }).from).not.toBe('annotation');
  });

  it('lets a published annotation outrank the table', () => {
    const declared = { name: 'memnox_memory', annotations: { destructiveHint: true } };
    expect(classifyTool(declared).class).toBe(TOOL_CLASS.DESTRUCTIVE);
  });

  it('reads the session tools as reads only on the session server', () => {
    expect(
      classifyToolCall('status', {}, ownToolDeclaration(SESSION_SERVER_NAME, 'status'))
        .class,
    ).toBe(TOOL_CLASS.READ);
    expect(ownToolDeclaration('someone-else', 'status')).toBeUndefined();
    expect(
      classifyToolCall('rewind', {}, ownToolDeclaration(SESSION_SERVER_NAME, 'rewind'))
        .class,
    ).toBe(TOOL_CLASS.DESTRUCTIVE);
  });
});

describe('declarations from the last scan', () => {
  const kept = snapshot([
    server('linear', [
      { name: 'issue_status', effect: 'read' },
      { name: 'frobnicate', effect: 'unknown' },
    ]),
    server('github', [{ name: 'issue_status', effect: 'write' }]),
  ]);
  const declared = toolDeclarations(kept);

  it('rules on a tool as its server listed it', () => {
    expect(
      classifyToolCall('issue_status', {}, declared('linear', 'issue_status')).class,
    ).toBe(TOOL_CLASS.READ);
    expect(
      classifyToolCall('issue_status', {}, declared('github', 'issue_status')).class,
    ).toBe(TOOL_CLASS.WRITE);
  });

  it('leaves the name to decide where servers disagree or nothing was said', () => {
    expect(declared('*', 'issue_status')).toBeUndefined();
    expect(declared('linear', 'frobnicate')).toBeUndefined();
    expect(declared('linear', 'never_listed')).toBeUndefined();
    expect(toolDeclarations(null)('linear', 'issue_status')).toBeUndefined();
  });

  it('keeps reading a statement, so a listed read handed DROP TABLE is not a read', () => {
    const db = toolDeclarations(
      snapshot([server('pg', [{ name: 'query', effect: 'read' }])]),
    );
    expect(
      classifyToolCall('query', { sql: 'DROP TABLE users' }, db('pg', 'query')).class,
    ).toBe(TOOL_CLASS.DESTRUCTIVE);
  });
});
