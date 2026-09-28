/**
 * What a shell line writes where the line itself holds the text (a heredoc, `echo`, `printf`,
 * `tee`), carried as the write's content so a fingerprint check reads it as it reads an edit.
 */
import { ACTION } from '../constants/action.constants';
import { TOOL_CLASS } from '../discovery/classify';
import type { ParsedCommand } from '../domain/shell-normalizer';
import { classifyReader } from './binary-class';

/** A write whose added lines the line shows, one per file it lands in. */
interface ShownWrite {
  action: string;
  class: string;
  because: string;
  target: string;
  /** LOCAL ONLY: the lines written, for a `content` convention. Never recorded. */
  content: readonly string[];
}

/** Every write the line shows the text of; a command whose output cannot be read gives none. */
export function shownWrites(
  parsed: readonly ParsedCommand[],
  env: NodeJS.ProcessEnv,
): ShownWrite[] {
  const shown: ShownWrite[] = [];
  for (const command of parsed) {
    const printed = printedBy(command);
    if (printed === null) continue;
    for (const target of printed.into) {
      shown.push({
        action: ACTION.FILESYSTEM_WRITE,
        class: TOOL_CLASS.WRITE,
        because: 'the line shows what it writes',
        // A reader's path rules, so the file is named the way every other write names it.
        target: classifyReader('cat', [target], env)?.target ?? target,
        content: printed.lines,
      });
    }
  }
  return shown;
}

/** The lines a command prints and the files they land in, or null where it cannot be read. */
function printedBy(command: ParsedCommand): { lines: string[]; into: string[] } | null {
  const [path, ...given] = command.argv;
  const binary = (path ?? '').split('/').pop() ?? '';
  // A here-string stays in argv for the commands that read the word itself; it is stdin here.
  const at = given.indexOf('<<<');
  const args = at === -1 ? given : [...given.slice(0, at), ...given.slice(at + 2)];
  const operands = args.filter((arg) => !arg.startsWith('-') || arg === '-');
  const redirected = command.writes ?? [];
  if (binary === 'tee') {
    const into = operands.filter((arg) => arg !== '-');
    return command.stdin === undefined || into.length === 0
      ? null
      : { lines: linesOf(command.stdin), into };
  }
  if (redirected.length === 0) return null;
  if (binary === 'cat') {
    // `cat file > other` copies a file nobody here has read, so only stdin is known.
    const fromStdin = operands.every((arg) => arg === '-');
    return command.stdin === undefined || !fromStdin
      ? null
      : { lines: linesOf(command.stdin), into: redirected };
  }
  if (binary === 'echo') return { lines: linesOf(echoed(args)), into: redirected };
  if (binary === 'printf') {
    const [format, ...values] = args;
    return format === undefined
      ? null
      : { lines: linesOf(formatted(format, values)), into: redirected };
  }
  return null;
}

/** What `echo` prints: its words past its own flags, escapes read as `-e` would. */
function echoed(args: readonly string[]): string {
  let at = 0;
  while (/^-[neE]+$/.test(args[at] ?? '')) at += 1;
  return args.slice(at).join(' ');
}

/** What `printf` prints, each value in its own pass of the format, as the shell does. */
function formatted(format: string, values: readonly string[]): string {
  if (values.length === 0 || !format.includes('%s')) return format;
  return values.map((value) => format.replace('%s', value)).join('');
}

/** Split on real newlines and written `\n` escapes, since either ends a line in the file. */
function linesOf(text: string): string[] {
  return text.split(/\n|\\n/).filter((line) => line !== '');
}
