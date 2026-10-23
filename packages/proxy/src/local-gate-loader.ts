import {
  FileAllowances,
  parentAgentsOf,
  ENV_AGENT_NAME,
  ENV_AGENT_ROLE,
  ENV_POLICIES,
  ENV_PRINCIPAL,
  LocalGate,
  loadPolicySet,
  readPolicyFiles,
} from '@memnox/core';

import { MCP_ACTION_PREFIX } from './firewall.constants';

/**
 * Where the proxy finds its rules: the environment first, then the registry every other
 * seam reads, since an editor started from a dock icon carries no environment at all.
 */
export interface LocalGateEnvironment {
  policies?: string;
  agentName?: string;
  /** The job `memnox run --role` enrolled the agent under, which a rule's `roles:` matches. */
  agentRole?: string;
  /** The person `memnox run --for` named, which a rule's `principals:` matches. */
  principal?: string;
}

/**
 * Null leaves the static tool filters as the only
 * gate, which is what an unconfigured machine has.
 */
export async function loadLocalGate(
  environment: LocalGateEnvironment,
  serverName: string,
  home: string,
  warn: (message: string) => void = () => undefined,
): Promise<LocalGate | null> {
  const files = await readPolicyFiles(environment.policies, home);
  if (files.length === 0) return null;

  // Tolerant of a broken file: throwing here would
  // start no MCP server at all on this machine.
  const set = await loadPolicySet(files);
  for (const broken of set.unreadable) {
    warn(
      `${broken.file} would not load, so its rules are not in force: ${broken.issues.length} problem(s)`,
    );
  }
  if (set.policies.length === 0 && set.unreadable.length > 0) {
    // Said out loud, because a machine with rules
    // it cannot read is not ungoverned by choice.
    warn('no rule file loaded, so nothing is being gated here');
    return null;
  }

  const allowances = new FileAllowances(home);
  return new LocalGate(set.policies, {
    agentName: environment.agentName ?? `${MCP_ACTION_PREFIX}:${serverName}`,
    allowances: () => allowances.inForceNow(new Date().toISOString()),
    ...(environment.agentRole === undefined ? {} : { agentRole: environment.agentRole }),
    ...(environment.principal === undefined ? {} : { principal: environment.principal }),
    ...(environment.agentName === undefined
      ? {}
      : { parents: parentAgentsOf(process.env, environment.agentName) }),
  });
}

export function localGateEnvironment(env: NodeJS.ProcessEnv): LocalGateEnvironment {
  return {
    policies: env[ENV_POLICIES],
    agentName: env[ENV_AGENT_NAME],
    agentRole: named(env[ENV_AGENT_ROLE]),
    principal: named(env[ENV_PRINCIPAL]),
  };
}

/** An empty variable names nobody, so it is absent rather than a person called "". */
function named(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}
