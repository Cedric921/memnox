import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMNOX_HOME } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { CLI_VERSION } from '../defaults';

/**
 * The Memnox extension in VS Code and the editors built on it, which brings forward the
 * integrated terminal a session runs in. Those editors offer no AppleScript for their
 * terminals, so this is the only way the voice can take somebody to the right one.
 */

/** What the Mac opens a link to, and what an uninstall names. */
export const TERMINALS_EXTENSION = 'memnox.memnox-terminals';

/** Each editor by the CLI inside its own bundle, since none of them is on PATH by default. */
const EDITORS: readonly { name: string; cli: string }[] = [
  {
    name: 'VS Code',
    cli: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  },
  { name: 'Cursor', cli: '/Applications/Cursor.app/Contents/Resources/app/bin/cursor' },
  {
    name: 'Windsurf',
    cli: '/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf',
  },
];

const EDITOR_TIMEOUT_MS = 60_000;

export interface TerminalsSeams {
  /** Runs a program with no shell, and says whether it exited cleanly and what it printed. */
  run: (file: string, args: readonly string[], cwd?: string) => Promise<Ran>;
  exists: (path: string) => boolean;
  /** The extension's built script, which ships beside this command. */
  script: () => string | null;
}

interface Ran {
  ok: boolean;
  output: string;
}

interface EditorOutcome {
  editor: string;
  done: boolean;
  why?: string;
}

export async function runVscodeTerminals(
  context: CliContext,
  home: string,
  reverting: boolean,
  seams: TerminalsSeams = NODE_SEAMS,
): Promise<void> {
  const { flow } = context;
  flow.open(reverting ? 'memnox protect --revert-vscode' : 'memnox protect --vscode');
  const editors = EDITORS.filter((each) => seams.exists(each.cli));
  if (editors.length === 0) {
    flow.close('No VS Code, Cursor or Windsurf in /Applications, so nothing changed.');
    return;
  }
  const outcomes = reverting
    ? await Promise.all(editors.map((each) => uninstallFrom(each, seams)))
    : await installInto(editors, home, seams);
  render(context, outcomes, reverting);
}

/** Every editor's row, then what changed for the voice, or that nothing did. */
function render(
  { flow, style }: CliContext,
  outcomes: readonly EditorOutcome[],
  reverting: boolean,
): void {
  const done = reverting ? 'removed' : 'installed';
  flow.rows(
    reverting ? 'Removed' : 'Installed',
    outcomes.map((each) => ({
      label: each.editor,
      value: each.done ? done : `not done: ${each.why ?? ''}`,
    })),
  );
  if (!outcomes.some((each) => each.done)) {
    flow.close(style.warn('Nothing changed.'));
    return;
  }
  if (reverting) {
    flow.close('The voice brings the editor forward again, without choosing a terminal.');
    return;
  }
  flow.close(
    'Asking the voice to go to a session now shows the very terminal it runs in.',
  );
  flow.hint('Reload any window already open, so it picks the extension up.');
  flow.hint('Undo with "memnox protect --revert-vscode".');
}

async function installInto(
  editors: readonly { name: string; cli: string }[],
  home: string,
  seams: TerminalsSeams,
): Promise<EditorOutcome[]> {
  const packaged = await packageExtension(home, seams);
  if (typeof packaged !== 'string') {
    return editors.map((each) => ({ editor: each.name, done: false, why: packaged.why }));
  }
  return Promise.all(
    editors.map(async (each) => {
      const ran = await seams.run(each.cli, ['--install-extension', packaged, '--force']);
      return ran.ok
        ? { editor: each.name, done: true }
        : { editor: each.name, done: false, why: lastLine(ran.output) };
    }),
  );
}

async function uninstallFrom(
  editor: { name: string; cli: string },
  seams: TerminalsSeams,
): Promise<EditorOutcome> {
  const ran = await seams.run(editor.cli, ['--uninstall-extension', TERMINALS_EXTENSION]);
  return ran.ok
    ? { editor: editor.name, done: true }
    : { editor: editor.name, done: false, why: lastLine(ran.output) };
}

/**
 * The extension as a `.vsix`, which is a zip of its manifest and files. Built here from the
 * script that ships with memnox, so the extension is always the version of the CLI beside it.
 */
async function packageExtension(
  home: string,
  seams: TerminalsSeams,
): Promise<string | { why: string }> {
  const script = seams.script();
  if (script === null) return { why: 'the extension was not built into this memnox' };
  const root = join(home, MEMNOX_HOME, 'vscode');
  const staging = join(root, 'staging');
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, 'extension', 'dist'), { recursive: true });
  await copyFile(script, join(staging, 'extension', 'dist', 'extension.js'));
  await writeFile(
    join(staging, 'extension', 'package.json'),
    `${JSON.stringify(manifest(), null, 2)}\n`,
  );
  await writeFile(join(staging, 'extension.vsixmanifest'), vsixManifest());
  await writeFile(join(staging, '[Content_Types].xml'), CONTENT_TYPES);
  const vsix = join(root, `memnox-terminals-${CLI_VERSION}.vsix`);
  await rm(vsix, { force: true });
  const zipped = await seams.run('/usr/bin/zip', ['-r', '-X', '-q', vsix, '.'], staging);
  return zipped.ok ? vsix : { why: `zip failed: ${lastLine(zipped.output)}` };
}

/** What VS Code reads as the extension's package.json: it wakes only to answer a link. */
function manifest(): Record<string, unknown> {
  return {
    name: 'memnox-terminals',
    displayName: 'Memnox terminals',
    description:
      'Lets the Memnox voice bring forward the terminal a session runs in, and type a confirmed instruction into it.',
    publisher: 'memnox',
    version: CLI_VERSION,
    license: 'Apache-2.0',
    engines: { vscode: '^1.74.0' },
    activationEvents: ['onUri'],
    main: './dist/extension.js',
  };
}

function vsixManifest(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="memnox-terminals" Version="${CLI_VERSION}" Publisher="memnox" />
    <DisplayName>Memnox terminals</DisplayName>
    <Description xml:space="preserve">Lets the Memnox voice bring forward the terminal a session runs in, and type a confirmed instruction into it.</Description>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.74.0" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
`;

function lastLine(output: string): string {
  const lines = output.split('\n').filter((line) => line.trim() !== '');
  return (lines[lines.length - 1] ?? 'it gave no reason').trim();
}

const NODE_SEAMS: TerminalsSeams = {
  run: (file, args, cwd) =>
    new Promise((resolve) => {
      execFile(
        file,
        [...args],
        { timeout: EDITOR_TIMEOUT_MS, ...(cwd === undefined ? {} : { cwd }) },
        (error, stdout, stderr) =>
          resolve({ ok: error === null, output: `${stdout}${stderr}` }),
      );
    }),
  exists: existsSync,
  script: () => {
    const here = dirname(fileURLToPath(import.meta.url));
    return (
      ['vscode/extension.js', '../vscode/extension.js']
        .map((relative) => join(here, relative))
        .find((path) => existsSync(path)) ?? null
    );
  },
};
