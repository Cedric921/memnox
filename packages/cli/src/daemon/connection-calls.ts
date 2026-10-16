import { DAEMON_METHOD, type DaemonRequest, type DaemonResponse } from '@memnox/core';
import { connectionsOf } from '../sync/personal-work';

/** Said when the list failed in a way nobody planned for, since the menu bar only ever shows words. */
const COULD_NOT_LIST = 'Your connected apps could not be listed just now.';

export function isConnectionsMethod(method: string): boolean {
  return method === DAEMON_METHOD.CONNECTIONS_LIST;
}

/** The Mac's menu bar and notch asking which apps the person connected; a refusal is a sentence, never a throw. */
export async function answerConnections(
  request: DaemonRequest,
  home: string,
  list: typeof connectionsOf = connectionsOf,
): Promise<DaemonResponse> {
  try {
    const answer = await list(home);
    return answer.ok
      ? { id: request.id, ok: true, connections: answer.value }
      : { id: request.id, ok: false, reason: answer.said };
  } catch {
    return { id: request.id, ok: false, reason: COULD_NOT_LIST };
  }
}
