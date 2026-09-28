/**
 * Most awk only prints, so it is read by its program rather than taken for an interpreter
 * that could write anywhere: a line using it to count words is not a line changing files.
 */

const AWKS: readonly string[] = ['awk', 'gawk', 'mawk', 'nawk'];

/** What lets an awk program write or run something: a redirect, a pipe, `system` or `getline`. */
const AWK_WRITES = /[>|]|\bsystem\s*\(|\bgetline\b/;

/** Options whose program is somewhere nobody here read, or that edit the file in place. */
const AWK_UNREAD = /^-(f|i|e|E)|^--(file|include|source|exec|in-place)/;

/** Whether a command is awk able to write, which a program with no redirect, pipe or `system` cannot. */
export function awkMayWrite(argv: readonly string[]): boolean {
  if (!AWKS.includes((argv[0] ?? '').split('/').pop() ?? '')) return false;
  const args = argv.slice(1);
  let at = 0;
  while (at < args.length) {
    const arg = args[at] ?? '';
    if (arg === '--') {
      at += 1;
      break;
    }
    if (!arg.startsWith('-')) break;
    if (AWK_UNREAD.test(arg)) return true;
    at += arg === '-F' || arg === '-v' ? 2 : 1;
  }
  const program = args[at];
  return program === undefined || AWK_WRITES.test(program);
}
