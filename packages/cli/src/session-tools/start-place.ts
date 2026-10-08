import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  EDITOR_APP,
  EDITOR_APPS,
  editorNamed,
  type EditorApp,
  type SessionStart,
  type StartableAgent,
} from '@memnox/core';
import { resolveInstalledApp } from './app-tools';
import { textArg, type SessionToolDeps, type ToolArgs } from './read-tools';
import { lastSurface, START_SURFACE, type KeptSurface } from './start-surface';

/**
 * Where a new session runs, which is part of what the person asked for: a terminal tab, the
 * agent's desktop app, or a new terminal inside the editor they named.
 */

export const PLACE = {
  APP: 'app',
  TERMINAL: 'terminal',
  EDITOR: 'editor',
  /** They named an editor that is not installed, which is said rather than started elsewhere. */
  NO_EDITOR: 'no-editor',
} as const;

/** Where a new session runs: a terminal tab, the agent's desktop app, or a terminal inside an editor. */
type Place =
  | { kind: typeof PLACE.APP | typeof PLACE.TERMINAL | typeof PLACE.NO_EDITOR }
  | { kind: typeof PLACE.EDITOR; editor: EditorApp; path: string };

/**
 * The editor they named, then the desktop app when they said so, then where they last had this
 * agent while it is still installed, and a terminal tab otherwise. A place they name always wins
 * over one remembered, since "in VS Code" said aloud is never a guess.
 */
export async function placeFor(
  deps: SessionToolDeps,
  args: ToolArgs,
  agent: StartableAgent,
): Promise<Place> {
  const editorSaid = textArg(args, 'editor');
  if (editorSaid !== undefined && editorSaid !== 'false') {
    const editor = editorSaid === 'true' ? null : editorNamed(editorSaid);
    return inEditor(deps, editor) ?? { kind: PLACE.NO_EDITOR };
  }
  const said = textArg(args, 'app');
  if (said !== undefined) return { kind: said === 'true' ? PLACE.APP : PLACE.TERMINAL };
  const last = await lastSurface(deps.home, agent);
  if (last?.surface === START_SURFACE.EDITOR) {
    return inEditor(deps, last.editor ?? null) ?? { kind: PLACE.TERMINAL };
  }
  const appThere =
    last?.surface === START_SURFACE.APP &&
    (deps.resolveApp ?? resolveInstalledApp)(agent) !== null;
  return { kind: appThere ? PLACE.APP : PLACE.TERMINAL };
}

/** The editor named, or with none named the first installed, or null when it is not on this Mac. */
function inEditor(deps: SessionToolDeps, named: EditorApp | null): Place | null {
  const resolve = deps.resolveEditor ?? resolveInstalledEditor;
  const editors = named === null ? Object.values(EDITOR_APP) : [named];
  for (const editor of editors) {
    const path = resolve(editor);
    if (path !== null) return { kind: PLACE.EDITOR, editor, path };
  }
  return null;
}

/** The editor's app bundle, the first place it is found installed. */
function resolveInstalledEditor(editor: EditorApp): string | null {
  return (
    EDITOR_APPS[editor].places
      .map((place) => (place.startsWith('~/') ? join(homedir(), place.slice(2)) : place))
      .find((place) => existsSync(place)) ?? null
  );
}

/** Where to start this agent next time, which is where it started now. */
export function surfaceOf(deps: SessionToolDeps, start: SessionStart): KeptSurface {
  if (start.app !== undefined) return { surface: START_SURFACE.APP };
  const editor = editorOf(deps, start);
  return editor === null
    ? { surface: START_SURFACE.TERMINAL }
    : { surface: START_SURFACE.EDITOR, editor };
}

/** Which editor the start's bundle is, or null for a start in a terminal tab. */
function editorOf(deps: SessionToolDeps, start: SessionStart): EditorApp | null {
  if (start.editor === undefined) return null;
  const resolve = deps.resolveEditor ?? resolveInstalledEditor;
  return Object.values(EDITOR_APP).find((each) => resolve(each) === start.editor) ?? null;
}

/** The editor as people name it, from the bundle the start was proposed with. */
export function editorName(deps: SessionToolDeps, start: SessionStart): string {
  const editor = editorOf(deps, start);
  return editor === null
    ? basename(start.editor ?? '', '.app')
    : EDITOR_APPS[editor].name;
}
