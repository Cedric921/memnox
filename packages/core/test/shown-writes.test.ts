import { describe, expect, it } from 'vitest';

import {
  DECISION_EFFECT,
  fingerprintPolicies,
  LocalGate,
  parseCodeFingerprint,
  resolveShellLine,
} from '../src';

/* A fingerprint check read only what an edit tool wrote, so the same line through a heredoc
   went through. Where the line itself shows the text, a shell write is held to the check. */

const ROOT = '/work/shop';
const FILE = `${ROOT}/src/http/Resource.java`;
const FORBIDDEN = 'orderRepository.update(b);';

const gate = new LocalGate(
  fingerprintPolicies(
    parseCodeFingerprint(`
enforce:
  - name: writes-only-in-actions
    files: ["src/http/**"]
    forbid: ["*Repository.update(*"]
    reason: all database writes go through Actions
`),
    ROOT,
  ),
  { agentName: 'claude-code' },
);

const ruled = (line: string): string[] =>
  resolveShellLine(line, { HOME: '/Users/me', PWD: ROOT }).actions.map(
    (each) =>
      gate.evaluate({
        action: each.action,
        toolClass: String(each.class),
        ...(each.target === undefined ? {} : { target: each.target }),
        ...(each.content === undefined ? {} : { content: each.content }),
      }).effect,
  );

describe('a shell line that shows what it writes', () => {
  it.each([
    `cat >> ${FILE} <<'EOF'\n        ${FORBIDDEN}\nEOF`,
    `cat > ${FILE} <<< '${FORBIDDEN}'`,
    `echo '${FORBIDDEN}' >> ${FILE}`,
    `printf '%s\\n' 'int x = 1;' '${FORBIDDEN}' > ${FILE}`,
    `tee -a ${FILE} <<'EOF'\n${FORBIDDEN}\nEOF`,
  ])('is refused where it adds a forbidden line: %s', (line) => {
    expect(ruled(line)).toContain(DECISION_EFFECT.DENY);
  });

  it.each([
    `cat >> ${FILE} <<'EOF'\n        actionFactory.create(Archive.class).run(params);\nEOF`,
    `echo '${FORBIDDEN}' >> ${ROOT}/src/action/Archive.java`,
    `echo '${FORBIDDEN}'`,
    `cat notes.txt > ${FILE}`,
  ])('goes ahead where it does not, or shows nothing written: %s', (line) => {
    expect(ruled(line)).not.toContain(DECISION_EFFECT.DENY);
  });

  it('carries the lines to each file it writes, and to no other', () => {
    const shown = resolveShellLine(
      `echo one > ${ROOT}/a.txt; echo two > ${ROOT}/b.txt`,
      {},
    ).actions.filter((each) => each.content !== undefined);

    expect(shown.map((each) => [each.target, each.content])).toEqual([
      [`${ROOT}/a.txt`, ['one']],
      [`${ROOT}/b.txt`, ['two']],
    ]);
  });
});
