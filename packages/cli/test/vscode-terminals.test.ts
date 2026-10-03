import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import {
  runVscodeTerminals,
  TERMINALS_EXTENSION,
  type TerminalsSeams,
} from '../src/protect/vscode-terminals';

const CODE = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';

/** Every call recorded; zip runs for real, so the package is the one an editor would get. */
async function seamsFor(calls: string[][]): Promise<TerminalsSeams> {
  const script = join(await mkdtemp(join(tmpdir(), 'memnox-vscode-script-')), 'e.js');
  await writeFile(script, 'exports.activate = () => {};\n');
  return {
    exists: (path) => path === CODE,
    script: () => script,
    run: (file, args, cwd) => {
      calls.push([file, ...args]);
      if (file !== '/usr/bin/zip') return Promise.resolve({ ok: true, output: '' });
      return new Promise((resolve) =>
        execFile(file, [...args], { cwd }, (error, out) =>
          resolve({ ok: error === null, output: out }),
        ),
      );
    },
  };
}

function listing(vsix: string): Promise<string> {
  return new Promise((resolve) =>
    execFile('/usr/bin/unzip', ['-Z1', vsix], (_error, out) => resolve(out)),
  );
}

describe('the extension that shows a session its own VS Code terminal', () => {
  it('packages itself and installs into the editors that are here', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-vscode-'));
    const calls: string[][] = [];
    const out = new RecordedOutput();
    await runVscodeTerminals(new CliContext(out), home, false, await seamsFor(calls));

    const install = calls.find((each) => each[0] === CODE);
    expect(install?.slice(1, 2)).toEqual(['--install-extension']);
    const vsix = install?.[2] ?? '';
    expect((await listing(vsix)).split('\n').sort()).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        'extension.vsixmanifest',
        'extension/package.json',
        'extension/dist/extension.js',
      ]),
    );
  });

  it('takes itself back out by its id', async () => {
    const calls: string[][] = [];
    const home = await mkdtemp(join(tmpdir(), 'memnox-vscode-'));
    await runVscodeTerminals(
      new CliContext(new RecordedOutput()),
      home,
      true,
      await seamsFor(calls),
    );
    expect(calls).toEqual([[CODE, '--uninstall-extension', TERMINALS_EXTENSION]]);
  });
});
