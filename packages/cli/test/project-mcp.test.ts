import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { isWrapped, PROXY_BINARY, wrapLaunch, type ServerLaunch } from '@memnox/core';

import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { unwrapEveryServer, wrapEveryServer } from '../src/mcp/wrap-servers';
import { resolveStyle } from '../src/style';

/* A repository's `.mcp.json` is the team's and usually committed. Rewriting it showed on
   every Memnox user's working tree and, once committed, broke teammates without the proxy,
   so its servers go behind the proxy in Claude Code's local scope, which only this machine
   reads, and only where the person already approved them. */

const ORIGINAL: ServerLaunch = { command: 'npx', args: ['-y', '@acme/tickets-mcp'] };
const OTHER: ServerLaunch = { command: 'npx', args: ['-y', '@acme/unvetted-mcp'] };
const PROXY_HERE = (): boolean => true;

interface Machine {
  home: string;
  repo: string;
  shared: string;
}

async function machine(
  local: Record<string, unknown> = {},
  approved: readonly string[] = ['tickets'],
  shared: Record<string, ServerLaunch> = { tickets: ORIGINAL, unvetted: OTHER },
): Promise<Machine> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-project-mcp-home-'));
  const repo = await mkdtemp(join(tmpdir(), 'memnox-project-mcp-repo-'));
  const sharedText = `${JSON.stringify({ mcpServers: shared }, null, 2)}\n`;
  await writeFile(join(repo, '.mcp.json'), sharedText);
  await writeFile(
    join(home, '.claude.json'),
    JSON.stringify({
      projects: {
        [repo]: { enabledMcpjsonServers: approved, mcpServers: local },
      },
    }),
  );
  return { home, repo, shared: sharedText };
}

async function localServers(m: Machine): Promise<Record<string, ServerLaunch>> {
  const config = JSON.parse(await readFile(join(m.home, '.claude.json'), 'utf8')) as {
    projects: Record<string, { mcpServers: Record<string, ServerLaunch> }>;
  };
  return config.projects[m.repo]?.mcpServers ?? {};
}

describe("a repository's MCP servers, behind the proxy", () => {
  it('goes through a local copy for each approved server, leaving the shared file alone', async () => {
    const m = await machine();

    const wrapped = await wrapEveryServer(m.home, m.repo, PROXY_HERE);

    expect(wrapped.names).toEqual(['tickets']);
    expect(wrapped.files).toEqual([join(m.home, '.claude.json')]);
    const local = await localServers(m);
    expect(local['tickets']?.command).toBe(PROXY_BINARY);
    expect(local['tickets'] === undefined ? false : isWrapped(local['tickets'])).toBe(
      true,
    );
    // Byte for byte what the team committed.
    expect(await readFile(join(m.repo, '.mcp.json'), 'utf8')).toBe(m.shared);
  });

  it('never switches on a server the person did not approve', async () => {
    const m = await machine();

    await wrapEveryServer(m.home, m.repo, PROXY_HERE);

    expect((await localServers(m))['unvetted']).toBeUndefined();
  });

  it("leaves a person's own local server of the same name alone", async () => {
    const mine: ServerLaunch = { command: 'node', args: ['my-own-tickets.js'] };
    const m = await machine({ tickets: mine });

    const wrapped = await wrapEveryServer(m.home, m.repo, PROXY_HERE);

    expect(wrapped.names).toEqual([]);
    expect((await localServers(m))['tickets']).toEqual(mine);
  });

  it('puts back a shared file an older Memnox wrapped in place, and wraps it locally', async () => {
    const m = await machine({}, ['tickets'], {
      tickets: wrapLaunch('tickets', ORIGINAL),
    });

    await wrapEveryServer(m.home, m.repo, PROXY_HERE);

    const shared = JSON.parse(await readFile(join(m.repo, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, ServerLaunch>;
    };
    expect(shared.mcpServers['tickets']).toEqual(ORIGINAL);
    expect((await localServers(m))['tickets']?.command).toBe(PROXY_BINARY);
  });

  it('takes its local copies back out on unwrap, and only its own', async () => {
    const mine: ServerLaunch = { command: 'node', args: ['mine.js'] };
    const m = await machine({ personal: mine });
    await wrapEveryServer(m.home, m.repo, PROXY_HERE);

    const context = new CliContext(new RecordedOutput(), resolveStyle({}, false));
    await unwrapEveryServer(m.home, m.repo, context);

    expect(await localServers(m)).toEqual({ personal: mine });
    expect(await readFile(join(m.repo, '.mcp.json'), 'utf8')).toBe(m.shared);
  });

  it('writes nothing where Claude Code keeps no config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-project-mcp-bare-'));
    const repo = await mkdtemp(join(tmpdir(), 'memnox-project-mcp-repo-'));
    const text = `${JSON.stringify({ mcpServers: { tickets: ORIGINAL } }, null, 2)}\n`;
    await writeFile(join(repo, '.mcp.json'), text);

    const wrapped = await wrapEveryServer(home, repo, PROXY_HERE);

    expect(wrapped.names).toEqual([]);
    expect(await readFile(join(repo, '.mcp.json'), 'utf8')).toBe(text);
  });
});
