import { describe, expect, it } from 'vitest';

import {
  checksBreakingExisting,
  DECISION_EFFECT,
  describeFingerprint,
  fingerprintPolicies,
  LocalGate,
  MOST_GUIDANCE_LINES,
  parseCodeFingerprint,
  proposalFrom,
  saysSomething,
  withoutChecks,
} from '../src';

const ROOT = '/work/shop';

/* The shape a team writes: preferences an agent is told, and checks it is held to. */
const FINGERPRINT = `
language:
  primary: typescript
naming:
  files: kebab-case
async:
  prefer: [async/await]
  avoid: [unnecessary promise chains]
enforce:
  - name: no-db-in-controllers
    files: ["src/**/*controller.ts"]
    forbid: ["*.query(*", "*prisma.*"]
    reason: no database calls from controllers
    instead: call a repository from the service
  - name: no-promise-chains
    files: ["src/**", "!src/legacy/**"]
    forbid: ["*.then(*"]
    reason: prefer async/await over promise chains
`;

describe("a repository's code fingerprint", () => {
  it('reads what is enforced apart from what is only stated', () => {
    const fingerprint = parseCodeFingerprint(FINGERPRINT);

    expect(fingerprint.issues).toEqual([]);
    expect(fingerprint.checks.map((check) => check.name)).toEqual([
      'no-db-in-controllers',
      'no-promise-chains',
    ]);
    expect(fingerprint.guidance).toEqual([
      'language.primary: typescript',
      'naming.files: kebab-case',
      'async.prefer: async/await',
      'async.avoid: unnecessary promise chains',
    ]);
  });

  it('tells the agent the whole of it once, the enforced lines named as such', () => {
    const told = describeFingerprint(parseCodeFingerprint(FINGERPRINT)) ?? '';

    expect(told).toContain('.memnox/code-fingerprint.yaml');
    expect(told).toContain('- naming.files: kebab-case');
    expect(told).toContain(
      '- enforced: no database calls from controllers (src/**/*controller.ts)',
    );
  });

  it('refuses a write that adds what a check forbids, only in the files it names', () => {
    const gate = new LocalGate(
      fingerprintPolicies(parseCodeFingerprint(FINGERPRINT), ROOT),
      {
        agentName: 'claude-code',
      },
    );
    const write = (path: string, line: string) =>
      gate.evaluate({
        action: 'filesystem.write',
        target: `${ROOT}/${path}`,
        toolClass: 'write',
        content: [line],
      });

    const refused = write(
      'src/orders/orders-controller.ts',
      'await prisma.order.findMany();',
    );
    expect(refused.effect).toBe(DECISION_EFFECT.DENY);
    expect(refused.reason).toContain('no database calls from controllers');
    expect(refused.alternative?.note).toBe('call a repository from the service');

    expect(
      write('src/orders/orders-repository.ts', 'await prisma.order.findMany();').effect,
    ).toBe(DECISION_EFFECT.ALLOW);
    expect(write('src/legacy/old.ts', 'fetch(url).then(read);').effect).toBe(
      DECISION_EFFECT.ALLOW,
    );
    expect(write('src/api.ts', 'fetch(url).then(read);').effect).toBe(
      DECISION_EFFECT.DENY,
    );
  });

  /* One bad entry must not stop every write in the repository, and must not vanish either. */
  it('skips a check it cannot read, and says why', () => {
    const fingerprint = parseCodeFingerprint(`
enforce:
  - name: half-written
    files: []
    forbid: ["*x*"]
  - name: fine
    files: ["src/**"]
    forbid: ["*debugger*"]
    reason: no debugger statements
`);

    expect(fingerprint.checks.map((check) => check.name)).toEqual(['fine']);
    expect(fingerprint.issues).toEqual([
      'enforce[0] is skipped: reason, files missing or empty',
    ]);
  });

  it('reads nothing into a file that is not YAML, and says so', () => {
    const fingerprint = parseCodeFingerprint('enforce: [\n');

    expect(fingerprint.checks).toEqual([]);
    expect(fingerprint.issues[0]).toContain('not YAML');
  });

  it('is bounded, so a long file cannot fill the session', () => {
    const long = Array.from({ length: 100 }, (_, n) => `rule${n}: keep it ${n}`).join(
      '\n',
    );

    expect(parseCodeFingerprint(long).guidance).toHaveLength(MOST_GUIDANCE_LINES);
  });
});

/* An agent proposes, and the code it was read out of decides: a check the repository
   already breaks does not describe it, and would refuse agents for writing like it. */
describe('a proposed check, tested against the code it describes', () => {
  const PROPOSED = `
naming:
  files: kebab-case
enforce:
  - name: no-console
    files: ["src/**"]
    forbid: ["*console.log(*"]
    reason: use the logger
  - name: no-then
    files: ["src/**"]
    forbid: ["*.then(*"]
    reason: use async/await
`;
  const files = [
    { path: `${ROOT}/src/a.ts`, lines: ['const x = await read();', 'console.log(x);'] },
    { path: `${ROOT}/scripts/b.ts`, lines: ['fetch(u).then(r);'] },
  ];

  it('names a check the code already breaks, with where, and keeps the one it follows', () => {
    const broken = checksBreakingExisting(parseCodeFingerprint(PROPOSED), ROOT, files);

    expect(broken).toEqual([{ name: 'no-console', lines: 1, first: 'src/a.ts' }]);
  });

  it('writes the proposal back without the dropped check and with everything else', () => {
    const kept = parseCodeFingerprint(withoutChecks(PROPOSED, new Set(['no-console'])));

    expect(kept.checks.map((check) => check.name)).toEqual(['no-then']);
    expect(kept.guidance).toEqual(['naming.files: kebab-case']);
  });

  it('takes the fences off an answer and reads it as the gate would', () => {
    const { fingerprint } = proposalFrom(`\`\`\`yaml\n${PROPOSED}\n\`\`\``);

    expect(fingerprint.checks).toHaveLength(2);
    expect(saysSomething(fingerprint)).toBe(true);
    expect(saysSomething(proposalFrom('I could not read it.').fingerprint)).toBe(false);
  });
});
