import { join } from 'node:path';
import {
  DISPLAY,
  DisplayRequests,
  discover,
  MEMNOX_HOME,
  NodeMachineReader,
  NodeSnapshotStore,
  SURFACE_KIND,
  TOOL_EFFECT,
  type AgentNode,
  type AgentServer,
  type DiscoveryReport,
  type EnvironmentSnapshot,
  type Surface,
} from '@memnox/core';
import { displayName, readNames } from '../agents/names';
import { textArg, type SessionToolDeps, type ToolArgs } from './read-tools';
import { sessionsTool } from './sessions-tool';

/**
 * "Scan my computer and show me my agents": a live scan, put on the whole screen with each
 * agent's logo and what it reaches, while the voice says it. It reads and starts nothing, not
 * even an MCP server, so it is safe to show any time.
 */

/** Session rows as the sessions tool returns them, read for the two counts the screen shows. */
interface SessionRow {
  agent: string;
  state: string;
}

const SHOWN =
  'Every agent is on their whole screen now, each with its logo, its MCP servers by name with their tools, and the signed in command line tools its shell can run. Say in one or two sentences how many there are, naming them, and which reaches the most and through what, like "Five agents. Claude Code reaches the most: a shell with GitHub and Vercel signed in, and four MCP servers including Linear." Never read the lists out.';

export async function showAgentsTool(
  deps: SessionToolDeps,
  args: ToolArgs,
  scan: (home: string) => Promise<DiscoveryReport | null> = liveScan,
  heard: (home: string) => Promise<EnvironmentSnapshot | null> = lastHeard,
): Promise<unknown> {
  const [report, snapshot] = await Promise.all([
    scan(deps.home),
    heard(deps.home).catch(() => null),
  ]);
  if (report === null || report.agents.length === 0) {
    return { shown: false, said: 'The scan found no agents on this Mac.' };
  }
  const nodes = await nodesOf(deps, report, snapshot);
  await new DisplayRequests(deps.home).request({
    display: DISPLAY.AGENTS,
    sessionId: 'scan',
    agent: 'memnox',
    title: textArg(args, 'title') ?? 'Your agents',
    agents: nodes,
    at: deps.now().toISOString(),
  });
  return {
    shown: true,
    agents: nodes.map(({ name, servers, reaches, working, open, mcp, clis }) => ({
      name,
      servers,
      reaches,
      working,
      open,
      mcp,
      clis,
    })),
    said: SHOWN,
  };
}

/** Each agent with counted facts only, from the scan and the sessions on record. */
async function nodesOf(
  deps: SessionToolDeps,
  report: DiscoveryReport,
  snapshot: EnvironmentSnapshot | null,
): Promise<AgentNode[]> {
  const [names, rows] = await Promise.all([
    readNames(deps.home),
    sessionsTool(deps, { hours: '24' }) as Promise<SessionRow[]>,
  ]);
  return report.agents.map((agent) => {
    const surfaces = report.surfaces.filter((each) => each.agentId === agent.id);
    const servers = surfaces.reduce((sum, each) => sum + (each.servers?.length ?? 0), 0);
    const reaches = [...new Set(surfaces.map((each) => each.kind))].filter(
      (kind) => kind !== SURFACE_KIND.MCP,
    );
    const own = rows.filter((row) => sameProduct(row.agent, agent.kind));
    const shell = surfaces.some((each) => each.kind === SURFACE_KIND.SHELL);
    return {
      id: agent.id,
      kind: agent.kind,
      name: displayName(names, agent),
      servers,
      reaches,
      working: own.filter((row) => row.state === 'working').length,
      open: own.filter((row) => row.state === 'open').length,
      mcp: serversOf(surfaces, snapshot),
      // A signed in CLI is reach only through a shell, so an agent without one is never credited.
      clis: shell ? signedIn(report) : [],
    };
  });
}

/** Each server by name once, with the tool counts the last scan that asked it recorded. */
function serversOf(
  surfaces: readonly Surface[],
  snapshot: EnvironmentSnapshot | null,
): AgentServer[] {
  const names = [
    ...new Set(surfaces.flatMap((each) => (each.servers ?? []).map((one) => one.name))),
  ];
  return names.map((name) => {
    const heard = snapshot?.servers.find((each) => each.name === name);
    if (heard === undefined || heard.tools.length === 0) return { name };
    const changing = heard.tools.filter(
      (tool) =>
        tool.effect === TOOL_EFFECT.WRITE || tool.effect === TOOL_EFFECT.DESTRUCTIVE,
    ).length;
    return { name, tools: heard.tools.length, changing };
  });
}

function signedIn(report: DiscoveryReport): string[] {
  return [...new Set((report.authenticated ?? []).map((each) => each.name))];
}

/** What the last full scan heard each server say it holds; read, never asked again here. */
async function lastHeard(home: string): Promise<EnvironmentSnapshot | null> {
  return new NodeSnapshotStore(join(home, MEMNOX_HOME)).latest();
}

/** A session names its agent as `codex` where the scan says `codex-cli`, and both are Codex. */
function sameProduct(sessionAgent: string, kind: string): boolean {
  const bare = (value: string): string => value.replace(/^agt_/, '').replace(/-cli$/, '');
  return bare(sessionAgent) === bare(kind);
}

/** The machine as it is now, with no MCP server started, so the scan is quick and starts nothing. */
async function liveScan(home: string): Promise<DiscoveryReport | null> {
  return discover(new NodeMachineReader(home), { now: new Date().toISOString() }).catch(
    () => null,
  );
}
