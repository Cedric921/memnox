import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LeaseGate,
  LeaseRegistry,
  upcomingRegion,
  WHOLE_FILE,
  type LeaseHolder,
  type WrittenRegion,
} from '@memnox/core';
import { afterEdit, claimEdit, editOf } from '../src/edit-hook';
import type { SeamLeases } from '../src/seam-runtime';

/* Two agents in one file on one machine used to meet on the file itself, whatever they
   were changing. Now they meet only where their edits do: the same method, a class and
   one of its methods, or overlapping lines where a change cannot be named. */

const NOW = '2026-09-27T10:00:00.000Z';

const SERVICE = [
  'export class PaymentService {',
  '  private readonly retries = 3;',
  '',
  '  async retryCharge(id: string): Promise<void> {',
  '    await this.charge(id);',
  '  }',
  '',
  '  refund(id: string): void {',
  '    this.charge(id);',
  '  }',
  '}',
  '',
].join('\n');

async function repository(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'memnox-same-code-'));
  await mkdir(join(root, 'src'));
  const file = join(root, 'src', 'payment-service.ts');
  await writeFile(file, SERVICE, 'utf8');
  return { root, file };
}

/** What the edit hook reads before it claims: the edit applied in memory and diffed. */
function regionOf(file: string, oldString: string, newString: string) {
  return async (): Promise<WrittenRegion> => {
    const before = await readFile(file, 'utf8');
    const after = afterEdit(before, {
      kind: 'edit',
      replacements: [{ from: oldString, to: newString, all: false }],
    });
    return after === null ? WHOLE_FILE : upcomingRegion(file, before, after);
  };
}

function leases(
  root: string,
  registry: LeaseRegistry,
  holder: LeaseHolder,
  region: () => Promise<WrittenRegion>,
): SeamLeases {
  return {
    gate: new LeaseGate({
      registry,
      now: () => NOW,
      sleep: async () => undefined,
      ceilingMs: 10,
      pollMs: 5,
      region,
    }),
    holder,
    repositoryRoot: root,
    isDirectory: (path) => !path.includes('.'),
  };
}

function editing(root: string, file: string, session: string, from: string, to: string) {
  const parsed = editOf({
    hook_event_name: 'PreToolUse',
    session_id: session,
    cwd: root,
    tool_name: 'Edit',
    tool_input: { file_path: file, old_string: from, new_string: to },
  });
  if (parsed === null) throw new Error('unread');
  return parsed;
}

const first: LeaseHolder = { agent: 'claude-code', sessionId: 's1', pid: 101 };
const second: LeaseHolder = { agent: 'cursor', sessionId: 's2', pid: 202 };

describe('two agents editing one file at once', () => {
  it('lets one change retryCharge while the other changes refund', async () => {
    const { root, file } = await repository();
    const registry = new LeaseRegistry(
      await mkdtemp(join(tmpdir(), 'memnox-home-')),
      () => true,
    );
    const a = [
      '    await this.charge(id);',
      '    await this.charge(id, { retry: true });',
    ] as const;
    const b = ['    this.charge(id);\n  }\n}', '    this.charge(-id);\n  }\n}'] as const;

    expect(
      await claimEdit(
        editing(root, file, 's1', ...a),
        leases(root, registry, first, regionOf(file, ...a)),
      ),
    ).toBeNull();
    expect(
      await claimEdit(
        editing(root, file, 's2', ...b),
        leases(root, registry, second, regionOf(file, ...b)),
      ),
    ).toBeNull();
  });

  it('stops the second on the same method and names the method it is waiting on', async () => {
    const { root, file } = await repository();
    const registry = new LeaseRegistry(
      await mkdtemp(join(tmpdir(), 'memnox-home-')),
      () => true,
    );
    const a = [
      '    await this.charge(id);',
      '    await this.charge(id, { retry: true });',
    ] as const;
    const b = [
      '  async retryCharge(id: string)',
      '  async retryCharge(id: string, times = 3)',
    ] as const;

    await claimEdit(
      editing(root, file, 's1', ...a),
      leases(root, registry, first, regionOf(file, ...a)),
    );
    const refused = await claimEdit(
      editing(root, file, 's2', ...b),
      leases(root, registry, second, regionOf(file, ...b)),
    );

    expect(refused?.reason).toContain(
      'claude-code is editing PaymentService.retryCharge',
    );
    const held = await registry.held(NOW);
    expect(held[0]?.symbols).toEqual(['PaymentService.retryCharge']);
  });

  it('stops a change to the class body while another agent is inside one of its methods', async () => {
    const { root, file } = await repository();
    const registry = new LeaseRegistry(
      await mkdtemp(join(tmpdir(), 'memnox-home-')),
      () => true,
    );
    const a = [
      '    await this.charge(id);',
      '    await this.charge(id, { retry: true });',
    ] as const;
    const b = [
      '  private readonly retries = 3;',
      '  private readonly retries = 5;',
    ] as const;

    await claimEdit(
      editing(root, file, 's1', ...a),
      leases(root, registry, first, regionOf(file, ...a)),
    );
    const refused = await claimEdit(
      editing(root, file, 's2', ...b),
      leases(root, registry, second, regionOf(file, ...b)),
    );

    expect(refused?.reason).toContain('claude-code');
  });
});
