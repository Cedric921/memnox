import {
  liftHeredocs,
  splitOutsideQuotes,
  takeRedirects,
  tokenizeQuoted,
  type Token,
} from './shell-words';

/** Indirection the normalizer could not resolve. Never silently ignored. */
export const OPAQUE_REASON = {
  /** $VAR, `cmd`, or $(cmd), where the real command is not knowable here. */
  EXPANSION: 'shell-expansion',
  /** A decoder whose input is not a literal, so nothing can be decoded. */
  UNDECODABLE: 'undecodable-payload',
  /** Piping a download into an interpreter: the payload lives elsewhere. */
  REMOTE_SOURCE: 'remote-source',
  /** Wrapper nesting past the bound; deeper layers went uninspected. */
  TOO_DEEP: 'nesting-too-deep',
} as const;

export type OpaqueReason = (typeof OPAQUE_REASON)[keyof typeof OPAQUE_REASON];

export interface NormalizedCommand {
  /**
   * Every executable command found, unwrapped and decoded where possible, with flags
   * sorted ahead of operands so the same command always reads the same way.
   */
  segments: string[];
  /**
   * The same commands with argv in the order it was typed. A verb table matches argv
   * as written, and `vercel deploy --prod` canonicalized to `vercel --prod deploy`
   * resolves to the wrong verb, so resolution reads these and patterns read the above.
   */
  commands: string[];
  /** Sorted, deduplicated. Non-empty means something could not be resolved. */
  opaque: OpaqueReason[];
  /**
   * The same commands again, as argv with quoting kept and redirects taken out, so a
   * quoted `"SELECT 1; DROP TABLE t"` stays one argument rather than two commands.
   */
  parsed: ParsedCommand[];
  /** Files the line's redirects write and read, which no argv shows. */
  redirects: Redirects;
}

export interface ParsedCommand {
  argv: string[];
  /** A heredoc or here-string, which is where `psql <<EOF` keeps its statement. */
  stdin?: string;
}

export interface Redirects {
  writes: string[];
  reads: string[];
}

const MAX_DEPTH = 4;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;
const EXPANSION = /\$\{?[A-Za-z_(]|`/;
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash']);
const CODE_FLAG_RUNNERS = new Map<string, string>([
  ['python', '-c'],
  ['python3', '-c'],
  ['perl', '-e'],
  ['ruby', '-e'],
  ['node', '-e'],
]);
const DECODERS = new Set(['base64', 'openssl']);
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch']);

/** Flattens a command into what it will really run; offline, never executes anything. */
interface FoundCommand {
  canonical: string;
  literal: string;
  parsed: ParsedCommand;
}

interface Walk {
  found: FoundCommand[];
  opaque: Set<OpaqueReason>;
  redirects: Redirects;
}

export function normalizeShellCommand(raw: string): NormalizedCommand {
  const state: Walk = {
    found: [],
    opaque: new Set(),
    redirects: { writes: [], reads: [] },
  };
  walk(raw, 0, state);

  // Deduplicated on the canonical form, so every list names the same commands.
  const seen = new Set<string>();
  const segments: string[] = [];
  const commands: string[] = [];
  const parsed: ParsedCommand[] = [];
  for (const command of state.found) {
    const key = `${command.canonical}\u0000${command.parsed.stdin ?? ''}`;
    if (command.canonical.length === 0 || seen.has(key)) continue;
    seen.add(key);
    segments.push(command.canonical);
    commands.push(command.literal);
    parsed.push(command.parsed);
  }
  return {
    segments,
    commands,
    opaque: [...state.opaque].sort(),
    parsed,
    redirects: {
      writes: [...new Set(state.redirects.writes)],
      reads: [...new Set(state.redirects.reads)],
    },
  };
}

function walk(raw: string, depth: number, state: Walk): void {
  const { found, opaque } = state;
  if (depth > MAX_DEPTH) {
    opaque.add(OPAQUE_REASON.TOO_DEEP);
    return;
  }
  const { text, bodies } = liftHeredocs(raw);
  const pipeline = splitOutsideQuotes(text).map((part) => part.trim());
  const pipesIntoInterpreter = pipeline.length > 1 && endsInInterpreter(pipeline);

  for (const part of pipeline) {
    if (part.length === 0) continue;
    const tokens = stripEnvTokens(tokenizeQuoted(part));
    const { kept, stdin } = takeRedirects(tokens, bodies, state.redirects);
    const words = kept.map((token) => token.text);
    if (words.length === 0) continue;

    if (EXPANSION.test(part)) opaque.add(OPAQUE_REASON.EXPANSION);
    // What a substitution runs is a command like any other, so `echo $(rm -rf ~)` is an rm.
    for (const body of substitutionsIn(part)) walk(body, depth + 1, state);

    const binary = basename(words[0] ?? '');
    if (pipesIntoInterpreter && DOWNLOADERS.has(binary)) {
      opaque.add(OPAQUE_REASON.REMOTE_SOURCE);
    }

    const inner = unwrap(binary, words, opaque);
    if (inner !== null) {
      walk(inner, depth + 1, state);
      continue;
    }
    found.push({
      canonical: canonicalize(words),
      literal: words.join(' '),
      parsed: { argv: words, ...(stdin === undefined ? {} : { stdin }) },
    });
  }
}

function stripEnvTokens(tokens: readonly Token[]): Token[] {
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index]?.text ?? ''))
    index += 1;
  return tokens.slice(index);
}

/** `curl x | sh`, where the last stage decides whether the pipeline executes. */
function endsInInterpreter(pipeline: readonly string[]): boolean {
  const last = pipeline[pipeline.length - 1];
  if (last === undefined) return false;
  const words = stripEnvTokens(tokenizeQuoted(last));
  return INTERPRETERS.has(basename(words[0]?.text ?? ''));
}

/**
 * The bodies of `$(...)` and backticks in a command, outermost first, so what they run is
 * ruled on rather than only noted as something the line could not see through.
 */
function substitutionsIn(part: string): string[] {
  const bodies: string[] = [];
  for (let at = 0; at < part.length; at += 1) {
    if (part[at] === '`') {
      const end = part.indexOf('`', at + 1);
      if (end === -1) break;
      bodies.push(part.slice(at + 1, end));
      at = end;
    } else if (part[at] === '$' && part[at + 1] === '(' && part[at + 2] !== '(') {
      let depth = 0;
      for (let end = at + 1; end < part.length; end += 1) {
        if (part[end] === '(') depth += 1;
        if (part[end] === ')') depth -= 1;
        if (depth === 0) {
          bodies.push(part.slice(at + 2, end));
          at = end;
          break;
        }
      }
    }
  }
  return bodies;
}

/** Words that only run the next one, and how many values each of their options takes. */
const PREFIXES = new Map<string, ReadonlySet<string>>([
  ['env', new Set(['-u', '--unset', '-C', '--chdir', '-S'])],
  ['sudo', new Set(['-u', '-g', '-C', '-h', '-p', '-U', '-r', '-t', '-D'])],
  ['doas', new Set(['-u', '-C'])],
  ['command', new Set()],
  ['nohup', new Set()],
  ['time', new Set()],
  ['nice', new Set(['-n'])],
  ['ionice', new Set(['-c', '-n', '-p'])],
  ['stdbuf', new Set(['-i', '-o', '-e'])],
  ['xargs', new Set(['-n', '-I', '-L', '-P', '-s', '-d', '-E', '-a'])],
]);

/** The command a prefix runs, past its own options, its `NAME=value` words and its duration. */
function afterPrefix(binary: string, words: readonly string[]): string | null {
  const valued = PREFIXES.get(binary);
  if (valued === undefined) return null;
  let at = 1;
  while (at < words.length) {
    const word = words[at] ?? '';
    if (valued.has(word)) at += 2;
    else if (word.startsWith('-') || ENV_ASSIGNMENT.test(word)) at += 1;
    else break;
  }
  const rest = words.slice(at);
  return rest.length === 0 ? null : rest.join(' ');
}

/** `timeout 5 rm x`: the duration is the first word, then the command. */
function afterTimeout(words: readonly string[]): string | null {
  let at = 1;
  while (at < words.length && (words[at] ?? '').startsWith('-')) at += 1;
  const rest = words.slice(at + 1);
  return rest.length === 0 ? null : rest.join(' ');
}

/** `find . -delete` removes what it finds, and `-exec rm {} ;` runs rm on each. */
function findRuns(words: readonly string[]): string | null {
  const exec = words.findIndex(
    (word) => word === '-exec' || word === '-execdir' || word === '-ok',
  );
  if (exec !== -1) {
    const end = words.findIndex(
      (word, at) => at > exec && (word === ';' || word === '\\;' || word === '+'),
    );
    return words.slice(exec + 1, end === -1 ? undefined : end).join(' ') || null;
  }
  if (words.includes('-delete')) {
    const start = words[1] !== undefined && !words[1].startsWith('-') ? words[1] : '.';
    return `rm -rf ${start}`;
  }
  return null;
}

/** `git -c alias.x='!rm -rf ~' x` runs the alias body as shell, whatever the verb says. */
function gitAliasRuns(words: readonly string[]): string | null {
  for (let at = 1; at < words.length - 1; at += 1) {
    if (words[at] !== '-c') continue;
    const shell = /^alias\.[^=]+=!(.+)$/.exec(words[at + 1] ?? '');
    if (shell !== null) return shell[1] ?? null;
  }
  return null;
}

/** `-c`, and the same flag run together with others: `bash -lc`, `sh -ec`. */
function codeFlagAt(words: readonly string[]): number {
  return words.findIndex((word, at) => at > 0 && /^-[a-z]*c[a-z]*$/.test(word));
}

/** Returns the wrapped command when this word list is a wrapper, else null. */
function unwrap(
  binary: string,
  words: readonly string[],
  opaque: Set<OpaqueReason>,
): string | null {
  if (binary === 'eval' || binary === 'exec') {
    return words.slice(1).join(' ');
  }
  if (binary === 'timeout') return afterTimeout(words);
  if (binary === 'find') return findRuns(words);
  if (binary === 'git') return gitAliasRuns(words);
  const prefixed = afterPrefix(binary, words);
  if (prefixed !== null) return prefixed;
  if (INTERPRETERS.has(binary)) {
    const index = codeFlagAt(words);
    if (index !== -1 && index + 1 < words.length) return words[index + 1] ?? null;
    return null;
  }
  const codeFlag = CODE_FLAG_RUNNERS.get(binary);
  if (codeFlag !== undefined) {
    const index = words.indexOf(codeFlag);
    if (index !== -1 && index + 1 < words.length) return words[index + 1] ?? null;
    return null;
  }
  if (DECODERS.has(binary) && isDecoding(words)) {
    const literal = words[words.length - 1];
    // A decoder reading a pipe or a file has no literal to decode here.
    if (literal === undefined || literal === '-' || looksLikeFlag(literal)) {
      opaque.add(OPAQUE_REASON.UNDECODABLE);
      return null;
    }
    const decoded = decodeBase64(literal);
    if (decoded === null) {
      opaque.add(OPAQUE_REASON.UNDECODABLE);
      return null;
    }
    return decoded;
  }
  return null;
}

function isDecoding(words: readonly string[]): boolean {
  return words.some((word) => word === '-d' || word === '--decode' || word === '-D');
}

function decodeBase64(value: string): string | null {
  if (!/^[A-Za-z0-9+/=\s]+$/.test(value) || value.length < 4) return null;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    // Reject binary noise: only a text command is worth re-inspecting.
    return /^[\x20-\x7e\s]+$/.test(decoded) && decoded.trim().length > 0 ? decoded : null;
  } catch {
    return null; // Not valid base64, so treat it as an ordinary argument.
  }
}

function basename(word: string): string {
  const parts = word.split('/');
  return parts[parts.length - 1] ?? word;
}

function looksLikeFlag(word: string): boolean {
  return word.startsWith('-');
}

/** One spelling per command, so `rm -r -f /x` and `/bin/rm -fr /x` match one pattern. */
function canonicalize(words: readonly string[]): string {
  const binary = basename(words[0] ?? '');
  const flags: string[] = [];
  const operands: string[] = [];

  for (const word of words.slice(1)) {
    if (word.startsWith('--')) {
      flags.push(word);
      continue;
    }
    if (word.startsWith('-') && word.length > 1) {
      for (const letter of word.slice(1)) flags.push(`-${letter}`);
      continue;
    }
    operands.push(word);
  }
  const unique = [...new Set(flags)].sort();
  return [binary, ...unique, ...operands].join(' ');
}
