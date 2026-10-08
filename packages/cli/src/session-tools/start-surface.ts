import { join } from 'node:path';
import {
  EDITOR_APPS,
  MEMNOX_HOME,
  readJsonFile,
  writeJsonFile,
  type EditorApp,
} from '@memnox/core';

/**
 * Where the person last had each agent started, its desktop app, a terminal or inside an editor,
 * so "start Hermes on the tests" goes where they had it before and a correction is said once.
 */

const SURFACE_FILE = join('voice', 'start-surfaces.json');

export const START_SURFACE = {
  APP: 'app',
  TERMINAL: 'terminal',
  EDITOR: 'editor',
} as const;

type StartSurface = (typeof START_SURFACE)[keyof typeof START_SURFACE];

/** Where an agent was last started, with the editor when it was inside one. */
export interface KeptSurface {
  surface: StartSurface;
  editor?: EditorApp;
}

/** An editor is kept as `editor:vscode`, so a file written before editors still reads. */
const EDITOR_PREFIX = `${START_SURFACE.EDITOR}:`;

export async function lastSurface(
  home: string,
  agent: string,
): Promise<KeptSurface | null> {
  const kept = await readJsonFile<Record<string, string>>(
    join(home, MEMNOX_HOME, SURFACE_FILE),
  );
  const surface = kept?.[agent];
  if (surface === START_SURFACE.APP || surface === START_SURFACE.TERMINAL)
    return { surface };
  const editor = surface?.startsWith(EDITOR_PREFIX)
    ? surface.slice(EDITOR_PREFIX.length)
    : undefined;
  return editor !== undefined && isEditor(editor)
    ? { surface: START_SURFACE.EDITOR, editor }
    : null;
}

function isEditor(name: string): name is EditorApp {
  return Object.keys(EDITOR_APPS).includes(name);
}

export async function keepSurface(
  home: string,
  agent: string,
  kept: KeptSurface,
): Promise<void> {
  const path = join(home, MEMNOX_HOME, SURFACE_FILE);
  const all = (await readJsonFile<Record<string, string>>(path)) ?? {};
  const value =
    kept.surface === START_SURFACE.EDITOR && kept.editor !== undefined
      ? `${EDITOR_PREFIX}${kept.editor}`
      : kept.surface;
  await writeJsonFile(path, { ...all, [agent]: value });
}
