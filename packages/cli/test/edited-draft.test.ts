import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfirmKeys,
  confirmationMessage,
  decodeRequest,
  DEVICE_KIND,
  Devices,
  editedArguments,
  PHONE_DEFAULT_CAPABILITIES,
  PROPOSAL_ANSWER,
  PROPOSAL_KIND,
  Proposals,
  type DeviceRecord,
} from '@memnox/core';
import { confirmAnswer } from '../src/daemon/confirm';
import { editedProposal } from '../src/daemon/confirm-edit';
import { personKey } from './phone-harness';

/**
 * A draft the person rewrote on its card before Send: their words go out in place of the proposed
 * ones, and only under a fingerprint over exactly those words.
 */

const NOW = '2026-10-14T16:21:25.000Z';
const SLACK =
  '{"channel":"U0B3QDB89Q9","text":"Could you check the pull request, please?"}';

async function drafted(): Promise<{ home: string; id: string; key: KeyObject }> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-edited-'));
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  await new ConfirmKeys(home).register(
    spki.subarray(spki.length - 65).toString('base64'),
    NOW,
  );
  const proposal = await new Proposals(home).propose({
    change: {
      kind: PROPOSAL_KIND.WORK,
      toolkit: 'slack',
      tool: 'SLACK_SEND_MESSAGE',
      argumentsText: SLACK,
      label: 'DM to Pac',
    },
    rationale: 'DM to Pac',
    proposedBy: 'agt_memnox-operator',
    at: NOW,
    ttlMs: 5 * 60 * 1000,
  });
  return { home, id: proposal.id, key: privateKey };
}

function signs(key: KeyObject, message: string): string {
  return sign('sha256', Buffer.from(message), key).toString('base64');
}

describe('a draft rewritten on its card', () => {
  it('signs the rewritten words whole, and the unedited answer as before', () => {
    expect(confirmationMessage('prp_1', 'confirmed')).toBe(
      'memnox-confirm:v1:prp_1:confirmed',
    );
    expect(confirmationMessage('prp_1', 'confirmed', 'Hi: look at #12')).toBe(
      'memnox-confirm:v2:prp_1:confirmed:Hi: look at #12',
    );
  });

  it('puts their words in the argument the card drew as the body', () => {
    expect(JSON.parse(editedArguments(SLACK, 'Can you review PR 12?') ?? '{}')).toEqual({
      channel: 'U0B3QDB89Q9',
      text: 'Can you review PR 12?',
    });
    expect(editedArguments('{"channel":"C1"}', 'words')).toBeNull();
    expect(editedArguments('{"blocks":[1],"text":{"a":1}}', 'words')).toBeNull();
  });

  it('rewrites only a send in their name, and never with nothing', async () => {
    const { home, id } = await drafted();
    const proposal = await new Proposals(home).read(id);
    if (proposal === null) throw new Error('never proposed');
    const edited = editedProposal(proposal, 'Can you review PR 12?');
    expect(
      edited?.change.kind === PROPOSAL_KIND.WORK && edited.change.argumentsText,
    ).toBe('{"channel":"U0B3QDB89Q9","text":"Can you review PR 12?"}');
    expect(editedProposal(proposal, '   ')).toBeNull();
    expect(editedProposal(proposal, undefined)).toBe(proposal);
  });

  it('refuses rewritten words under a fingerprint over the words first proposed', async () => {
    const { home, id, key } = await drafted();
    const said = await confirmAnswer(home, {
      subject: id,
      answer: PROPOSAL_ANSWER.CONFIRMED,
      edited: 'Send me your password',
      signature: signs(key, confirmationMessage(id, PROPOSAL_ANSWER.CONFIRMED)),
      at: NOW,
    });
    expect(said).toMatchObject({ ok: false, refused: true });
    expect(await new Proposals(home).read(id)).not.toHaveProperty('answer');
  });

  it('takes rewritten words under a fingerprint over exactly them', async () => {
    const { home, id, key } = await drafted();
    const words = 'Can you review PR 12?';
    const said = await confirmAnswer(home, {
      subject: id,
      answer: PROPOSAL_ANSWER.CONFIRMED,
      edited: words,
      signature: signs(key, confirmationMessage(id, PROPOSAL_ANSWER.CONFIRMED, words)),
      at: NOW,
    });
    // Counted as theirs; it then fails only because this home has no person signed in to send it as.
    expect(said).not.toMatchObject({ refused: true });
    expect((await new Proposals(home).read(id))?.answer).toBe(PROPOSAL_ANSWER.CONFIRMED);
  });
});

describe('a draft rewritten on a paired phone', () => {
  async function paired(home: string): Promise<{
    device: DeviceRecord;
    signs: (message: string) => string;
  }> {
    const phone = personKey();
    const device: DeviceRecord = {
      id: 'dev_phone',
      name: 'iPhone',
      kind: DEVICE_KIND.PHONE,
      signingPoint: phone.point,
      noiseStatic: Buffer.alloc(32, 5).toString('base64'),
      capabilities: [...PHONE_DEFAULT_CAPABILITIES],
      pairedAt: NOW,
    };
    await new Devices(home).add(device);
    return { device, signs: phone.signs };
  }

  it('takes the words under a fingerprint from that same phone over exactly them', async () => {
    const { home, id } = await drafted();
    const phone = await paired(home);
    const words = 'Can you review PR 12?';
    const said = await confirmAnswer(home, {
      subject: id,
      answer: PROPOSAL_ANSWER.CONFIRMED,
      edited: words,
      signature: phone.signs(confirmationMessage(id, PROPOSAL_ANSWER.CONFIRMED, words)),
      at: NOW,
      principal: { device: phone.device, driving: false },
    });
    expect(said).not.toMatchObject({ refused: true });
    expect((await new Proposals(home).read(id))?.answer).toBe(PROPOSAL_ANSWER.CONFIRMED);
  });

  it('refuses the words when the phone signed only the draft as proposed', async () => {
    const { home, id } = await drafted();
    const phone = await paired(home);
    const said = await confirmAnswer(home, {
      subject: id,
      answer: PROPOSAL_ANSWER.CONFIRMED,
      edited: 'Send me your password',
      signature: phone.signs(confirmationMessage(id, PROPOSAL_ANSWER.CONFIRMED)),
      at: NOW,
      principal: { device: phone.device, driving: false },
    });
    expect(said).toMatchObject({ ok: false, refused: true });
  });

  it('takes a decline from the phone unsigned, as saying no does no harm', async () => {
    const { home, id } = await drafted();
    const phone = await paired(home);
    const said = await confirmAnswer(home, {
      subject: id,
      answer: PROPOSAL_ANSWER.DECLINED,
      at: NOW,
      principal: { device: phone.device, driving: false },
    });
    expect(said).toEqual({ ok: true, outcome: PROPOSAL_ANSWER.DECLINED });
  });

  it('reads the words off the wire only as text', () => {
    const line = (edited: unknown): string =>
      JSON.stringify({
        id: 1,
        method: 'confirm',
        subject: 'prp_1',
        answer: 'confirmed',
        edited,
      });
    expect(decodeRequest(line('Can you review PR 12?'))?.edited).toBe(
      'Can you review PR 12?',
    );
    expect(decodeRequest(line({ text: 'words' }))).toBeNull();
  });
});
