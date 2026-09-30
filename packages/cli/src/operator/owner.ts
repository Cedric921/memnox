import { join } from 'node:path';
import { MEMNOX_HOME, readJsonFile, writeJsonFile } from '@memnox/core';

/**
 * The name the person asked the voice to call them, told to the daemon by the Mac app, so
 * the brain can speak to them by name. A name and nothing else, and it stays on this Mac.
 */

const OWNER_FILE = join('voice', 'owner.json');

interface Owner {
  name: string;
}

/** Long enough for any first name, short enough that nothing else rides in with it. */
const NAME_LIMIT = 40;

export async function readOwner(home: string): Promise<string | undefined> {
  const kept = await readJsonFile<Owner>(join(home, MEMNOX_HOME, OWNER_FILE));
  return typeof kept?.name === 'string' && kept.name.trim() !== ''
    ? kept.name.trim()
    : undefined;
}

/** Only a plain name is kept, since it is written into the brain's own instructions. */
export async function keepOwner(home: string, name: string): Promise<void> {
  const plain = name
    .replace(/[^\p{L}\p{M}' -]/gu, '')
    .trim()
    .slice(0, NAME_LIMIT);
  if (plain === '' || plain === (await readOwner(home))) return;
  await writeJsonFile(join(home, MEMNOX_HOME, OWNER_FILE), { name: plain });
}
