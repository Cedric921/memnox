import { describe, expect, it } from 'vitest';
import { agentShown, plainAsk, taskShown, whyShown } from '../src/gate/plain-ask';

const DELETE = {
  agent: 'claude-code',
  operation: 'filesystem.delete',
  target: 'finish-cloud.patch',
  reason:
    'you chose to be asked about this: sometimes it really is the build directory, so a person should look',
};

describe('a held call in the words a person reads', () => {
  it('names the product and says what it wants to do', () => {
    expect(plainAsk(DELETE).summary).toBe(
      'Claude Code wants to delete finish-cloud.patch.',
    );
  });

  it('turns the rule reason into a sentence to the person', () => {
    expect(plainAsk(DELETE).why).toBe(
      'You asked to check this yourself: sometimes it really is the build directory, so a person should look.',
    );
  });

  it('says a shell variable is a path it only learns when it runs, rather than printing $S', () => {
    expect(plainAsk({ ...DELETE, target: '$S' }).summary).toBe(
      'Claude Code wants to delete a path its command keeps in $S, which only resolves when it runs.',
    );
  });

  it.each([
    [
      'git.push-force',
      'main',
      'Claude Code wants to force-push, overwriting the remote history of main.',
    ],
    ['http.request', 'api.stripe.com', 'Claude Code wants to connect to api.stripe.com.'],
    ['shell.execute', undefined, 'Claude Code wants to run a command.'],
    [
      'mcp.github.merge_pull_request',
      undefined,
      'Claude Code wants to use merge_pull_request on github.',
    ],
    [
      'vercel.deploy-production',
      'shop',
      'Claude Code wants to do vercel.deploy-production on shop.',
    ],
  ])('reads %s plainly', (operation, target, summary) => {
    const request = {
      ...DELETE,
      operation,
      ...(target === undefined ? { target: undefined } : { target }),
    };
    expect(plainAsk(request).summary).toBe(summary);
  });

  it('quotes the task the person gave, cut at a word', () => {
    const long = `fix the flaky billing retry test ${'and keep going '.repeat(20)}`;
    const shown = taskShown(long) ?? '';
    expect(shown.length).toBeLessThanOrEqual(121);
    expect(shown.endsWith('…')).toBe(true);
    expect(shown).not.toMatch(/\s…$/);
    expect(plainAsk(DELETE, 'tidy the patches').task).toBe('tidy the patches');
  });

  it('never leaves an agent or a reason blank', () => {
    expect(agentShown('an agent')).toBe('An agent');
    expect(agentShown('agt_codex-cli')).toBe('Codex');
    expect(whyShown('')).toBe('A rule on this machine asks a person first.');
  });
});
