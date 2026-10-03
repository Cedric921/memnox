/**
 * Which integrated terminal a session runs in, found by the terminal device its shell holds,
 * since VS Code names a terminal only by the pid of the shell it started.
 */

/** A terminal as far as matching needs it: the pid of its shell, once VS Code knows it. */
interface ShellTerminal<T> {
  terminal: T;
  processId: Promise<number | undefined>;
}

/** `ttys013`, `/dev/ttys013` and `s013` name one device, so all are compared as `ttys013`. */
export function deviceName(tty: string): string {
  const bare = tty.trim().replace(/^\/dev\//, '');
  return bare.startsWith('tty') ? bare : `tty${bare}`;
}

/** The first terminal whose shell holds the device, or null where none of them does. */
export async function terminalOn<T>(
  tty: string,
  terminals: readonly ShellTerminal<T>[],
  deviceOf: (pid: number) => Promise<string | null>,
): Promise<T | null> {
  const wanted = deviceName(tty);
  for (const each of terminals) {
    const pid = await each.processId;
    if (pid === undefined) continue;
    const device = await deviceOf(pid);
    if (device !== null && deviceName(device) === wanted) return each.terminal;
  }
  return null;
}

/** A device as the Mac sends it: only a real terminal name, since it arrives in a link anyone can open. */
export function deviceFromLink(query: string): string | null {
  const tty = new URLSearchParams(query).get('tty');
  if (tty === null) return null;
  return /^(\/dev\/)?ttys?[0-9]+$/.test(tty) ? tty : null;
}
