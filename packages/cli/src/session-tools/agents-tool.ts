import {
  DISPLAY,
  DisplayRequests,
  discover,
  NodeMachineReader,
  SURFACE_KIND,
  type AgentNode,
  type DiscoveryReport,
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
  'Every agent is on their whole screen now, each with its logo and what it reaches. Say in one or two sentences how many there are, naming them, and which reaches the most, like "Five agents. Claude Code reaches the most, with a shell and four MCP servers." Never read the counts out one by one.';

export async function showAgentsTool(
  deps: SessionToolDeps,
  args: ToolArgs,
  scan: (home: string) => Promise<DiscoveryReport | null> = liveScan,
): Promise<unknown> {
  const report = await scan(deps.home);
  if (report === null || report.agents.length === 0) {
    return { shown: false, said: 'The scan found no agents on this Mac.' };
  }
  const nodes = await nodesOf(deps, report);
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
    agents: nodes.map(({ name, servers, reaches, working, open }) => ({
      name,
      servers,
      reaches,
      working,
      open,
    })),
    said: SHOWN,
  };
}

/** Each agent with counted facts only, from the scan and the sessions on record. */
async function nodesOf(
  deps: SessionToolDeps,
  report: DiscoveryReport,
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
    return {
      id: agent.id,
      kind: agent.kind,
      name: displayName(names, agent),
      servers,
      reaches,
      working: own.filter((row) => row.state === 'working').length,
      open: own.filter((row) => row.state === 'open').length,
    };
  });
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
