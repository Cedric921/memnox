/**
 * The egress proxy the daemon holds, started and stopped with it, and the one a session
 * gets when there is no daemon or its repository is untrusted. Every request is ruled on
 * by host, written to the ledger, and entered in the calling agent's destination record.
 */
import { readFile } from 'node:fs/promises';

import {
  DestinationRecords,
  ENV_AGENT_NAME,
  holdFor,
  openLedger,
  protectionStopped,
  SESSION_VAR,
  writeJsonFile,
  type LocalGate,
} from '@memnox/core';
import {
  containmentFor,
  EgressSeam,
  HookAuthorizer,
  recordEgress,
  startEgressProxy,
  type EgressCaller,
  type EgressProxy,
  type EgressProxyOptions,
} from '@memnox/interceptors';
import { egressStatePath } from '../memnox-paths';

/** What the daemon writes down about its proxy, so a run can find it. */
interface EgressState {
  port: number;
  pid: number;
  startedAt: string;
}

interface EgressSeamInput {
  home: string;
  /** The rules in force; absent, only containment and the payload inspector rule. */
  gate?: LocalGate;
  log: (message: string) => void;
  /** A proxy of one session's own, which ignores whatever a client claims to be. */
  fixed?: EgressCaller;
  now?: () => Date;
}

/** The seam every proxy here is built around, the daemon's and a session's alike. */
export function egressSeamFor(input: EgressSeamInput): EgressSeam {
  const { home, fixed } = input;
  const now = input.now ?? ((): Date => new Date());
  const record = recordEgress(openLedger(home), new DestinationRecords(home), now);
  return new EgressSeam({
    authorizer: new HookAuthorizer({
      ...(input.gate === undefined ? {} : { gate: input.gate }),
      stopped: () => protectionStopped(home, now()),
    }),
    // The terminal belongs to the agent, so a question is written down and answered elsewhere.
    hold: holdFor({ home, interactive: false, announce: input.log }),
    contain: (caller) =>
      containmentFor({
        home,
        env: environmentOf(fixed ?? caller),
        cwd: home,
        now: now(),
        rootOf: () => null,
      }),
    ruled: (ruling) =>
      record(fixed === undefined ? ruling : { ...ruling, caller: fixed }),
  });
}

/** The caller as the variables a seam reads, so containment is decided one way everywhere. */
function environmentOf(caller: EgressCaller): NodeJS.ProcessEnv {
  return {
    ...(caller.sessionId === undefined ? {} : { [SESSION_VAR]: caller.sessionId }),
    ...(caller.agent === undefined ? {} : { [ENV_AGENT_NAME]: caller.agent }),
  };
}

interface DaemonEgressOptions {
  gate?: LocalGate;
  log: (message: string) => void;
  /** Injected so a test starts nothing that listens. */
  start?: (options: EgressProxyOptions) => Promise<EgressProxy>;
  now?: () => Date;
}

/** Started with the daemon and stopped with it, and its port written where a run looks. */
export class DaemonEgress {
  private proxy: EgressProxy | null = null;

  constructor(
    private readonly home: string,
    private readonly options: DaemonEgressOptions,
  ) {}

  /** The port it took, or null when none could be bound, which the daemon survives. */
  async start(): Promise<number | null> {
    const seam = egressSeamFor({
      home: this.home,
      log: this.options.log,
      ...(this.options.gate === undefined ? {} : { gate: this.options.gate }),
    });
    const proxy = await this.listen(seam, await previousPort(this.home));
    if (proxy === null) return null;
    this.proxy = proxy;
    const state: EgressState = {
      port: proxy.port,
      pid: process.pid,
      startedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    };
    await writeJsonFile(egressStatePath(this.home), state);
    return proxy.port;
  }

  async stop(): Promise<void> {
    const proxy = this.proxy;
    this.proxy = null;
    if (proxy === null) return;
    await proxy.close();
    // No pid, so no run leans on a port nobody holds, but the next daemon can take it back.
    const stopped: StoppedEgress = { lastPort: proxy.port };
    await writeJsonFile(egressStatePath(this.home), stopped);
  }

  /**
   * The port the last daemon held first, because an agent already running was pointed at it
   * and a restart on a new port refuses every call it makes; otherwise any free port, since
   * a run reads it from the state file and 8888 is Jupyter's.
   */
  private async listen(
    seam: EgressSeam,
    previous: number | null,
  ): Promise<EgressProxy | null> {
    const start = this.options.start ?? startEgressProxy;
    if (previous !== null) {
      try {
        return await start({ seam, port: previous, log: this.options.log });
      } catch {
        // Somebody else took it while no daemon was running; a fresh port is all that is left.
      }
    }
    try {
      return await start({ seam, port: 0, log: this.options.log });
    } catch (err) {
      this.options.log(`The egress proxy could not listen: ${String(err)}`);
      return null;
    }
  }
}

/** What a stopped daemon leaves behind: the port to ask for again, and no pid to lean on. */
interface StoppedEgress {
  lastPort: number;
}

/** The port the previous daemon held, whether it stopped cleanly or died holding it. */
async function previousPort(home: string): Promise<number | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(egressStatePath(home), 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const port = record['lastPort'] ?? record['port'];
    return typeof port === 'number' && port > 0 ? port : null;
  } catch {
    // No file is a first start, or one whose state was cleared by hand.
    return null;
  }
}

/** The daemon's proxy port, while the daemon that wrote it is still alive. */
export async function daemonEgressPort(
  home: string,
  alive: (pid: number) => boolean = isAlive,
): Promise<number | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(egressStatePath(home), 'utf8'));
    if (!isEgressState(parsed)) return null;
    return alive(parsed.pid) ? parsed.port : null;
  } catch {
    // No file is a daemon that is not running, or one that never started a proxy.
    return null;
  }
}

function isEgressState(value: unknown): value is EgressState {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record['port'] === 'number' && typeof record['pid'] === 'number';
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Gone, or not ours to signal: either way not a daemon this run can lean on.
    return false;
  }
}
