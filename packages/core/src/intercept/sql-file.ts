/**
 * The one part of the SQL check that reads a file: the statements behind `psql -f`. Kept
 * apart from `sql.ts` so the statement check itself stays pure and loads where no disk is.
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Flags whose value is a file of statements, per client. */
const FILE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  psql: ['-f', '--file'],
};

/** Past this the file is not read, and the command stays the write its client table says. */
const MOST_STATEMENT_BYTES = 512 * 1024;

/**
 * The statements in a file the client was pointed at, as `psql -f migrate.sql`. Null when
 * there is none, it is too big, or it will not read, which leaves the command a write.
 */
export function fileStatementIn(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string | null {
  const flags = FILE_FLAGS[binary];
  if (flags === undefined) return null;
  const path = valueAfter(args, flags);
  if (path === undefined || path === '-') return null;
  const absolute = isAbsolute(path) ? path : join(env['PWD'] ?? process.cwd(), path);
  try {
    if (statSync(absolute).size > MOST_STATEMENT_BYTES) return null;
    return readFileSync(absolute, 'utf8');
  } catch {
    // A file that will not read is one nothing here can vouch for.
    return null;
  }
}

function valueAfter(
  args: readonly string[],
  flags: readonly string[],
): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (flags.includes(arg)) return args[index + 1];
    const inline = flags.find(
      (flag) => flag.startsWith('--') && arg.startsWith(`${flag}=`),
    );
    if (inline !== undefined) return arg.slice(inline.length + 1);
  }
  return undefined;
}
