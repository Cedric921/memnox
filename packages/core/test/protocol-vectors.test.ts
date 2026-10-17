import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { protocolVectors, protocolVectorsJson, verifiesSigned } from '../src/index';

const committed = fileURLToPath(
  new URL('../../../vectors/protocol.json', import.meta.url),
);

describe('protocol vectors', () => {
  it('match the committed file, so a protocol change cannot ship without the clients seeing it', () => {
    // Run `pnpm vectors` and commit vectors/protocol.json when this fails.
    expect(readFileSync(committed, 'utf8')).toBe(protocolVectorsJson());
  });

  it('carry a signature the daemon accepts in DER', () => {
    const { point, message, der } = protocolVectors().signature;
    expect(verifiesSigned(point, message, der)).toBe(true);
  });

  it('carry the same signature raw, which the daemon refuses, so a client must convert it', () => {
    const { point, message, p1363 } = protocolVectors().signature;
    expect(verifiesSigned(point, message, p1363)).toBe(false);
  });

  it('write an empty rewrite as v2, never as the v1 of no rewrite', () => {
    const empty = protocolVectors().messages.find(
      (each) => each.name === 'confirm-rewritten-empty',
    );
    expect(empty?.message).toBe('memnox-confirm:v2:prp_3:confirmed:');
  });
});
