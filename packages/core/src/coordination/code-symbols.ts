import type { LineRange } from './written-region';

/**
 * The function, method or class each line sits in, as `PaymentService.retryCharge`, read off
 * declarations and indentation. Git's hunk context names the line above a hunk: a method's class.
 */

/** A declaration that opens a block other code sits inside. */
interface Opened {
  indent: number;
  name: string;
  /** Whether a method can be declared directly inside it. */
  holdsMethods: boolean;
}

/** A declaration keyword and where its name is. First match wins. */
interface Declaration {
  pattern: RegExp;
  holdsMethods: boolean;
}

const MODIFIERS =
  '(?:(?:export|default|declare|abstract|public|private|protected|internal|static|final|sealed|open|override|async|unsafe|pub(?:\\([^)]*\\))?|data|inline|suspend)\\s+)*';

const DECLARATIONS: readonly Declaration[] = [
  // Types and modules: class, interface, struct, enum, trait, namespace, module, object.
  {
    pattern: new RegExp(
      `^${MODIFIERS}(?:class|interface|struct|enum|trait|namespace|module|object|record)\\s+([A-Za-z_$][\\w$]*)`,
    ),
    holdsMethods: true,
  },
  // Rust `impl Type` and `impl Trait for Type`, named by the type.
  {
    pattern: /^impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+?\s+for\s+)?([A-Za-z_][\w]*)/,
    holdsMethods: true,
  },
  // Go `type Name struct`.
  { pattern: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, holdsMethods: true },
  // Functions: TypeScript and JavaScript, Python, Rust, Go (with its receiver), Kotlin, Ruby.
  {
    pattern: new RegExp(
      `^${MODIFIERS}(?:function\\*?|def|fn|fun|func(?:\\s*\\([^)]*\\))?)\\s+(?:self\\.)?([A-Za-z_$][\\w$]*)`,
    ),
    holdsMethods: false,
  },
  // A function held in a binding: `const retry = async (` or `= function`.
  {
    pattern: new RegExp(
      `^${MODIFIERS}(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]+)?=>|[A-Za-z_$][\\w$]*\\s*=>)`,
    ),
    holdsMethods: false,
  },
];

/** A method, only directly inside what holds methods, since `charge(amount) {` is a call elsewhere. */
const METHOD = new RegExp(
  `^${MODIFIERS}(?:(?:get|set|readonly|virtual|synchronized)\\s+)*(?:[\\w<>\\[\\],.?]+\\s+)*([A-Za-z_$][\\w$]*)\\s*(?:<[^>]*>)?\\s*\\(`,
);

/** Words a method pattern must never take as a name. */
const NOT_A_METHOD = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'new',
  'throw',
  'await',
  'yield',
  'super',
  'this',
  'typeof',
  'function',
]);

/** A line that only continues or closes what came before it. */
const CONTINUES = /^[)\]]/;
const CLOSES = /^[}\]]|^end\b/;

/** Blank lines and comments say nothing about where a block ends. */
const SAYS_NOTHING = /^(?:$|\/\/|#(?!\[)|\/\*|\*|--|@)/;

/** The innermost declaration each line sits in, index 0 for line 1, null outside every one. */
export function enclosingNames(source: string): Array<string | null> {
  const rows = source.split('\n');
  const names: Array<string | null> = [];
  const open: Opened[] = [];

  for (const row of rows) {
    const text = row.trim();
    const indent = indentOf(row);
    if (SAYS_NOTHING.test(text)) {
      names.push(qualified(open));
      continue;
    }
    if (CONTINUES.test(text)) {
      names.push(qualified(open));
      continue;
    }
    const closing = CLOSES.test(text);
    // A line at or left of a block's opening line ends that block, closer lines excepted.
    while (open.length > 0) {
      const top = open[open.length - 1];
      if (top === undefined || indent > top.indent) break;
      if (closing && indent === top.indent) break;
      open.pop();
    }
    if (closing) {
      // The closer still belongs to the block it closes.
      names.push(qualified(open));
      const top = open[open.length - 1];
      if (top !== undefined && indent === top.indent) open.pop();
      continue;
    }
    const declared = declarationIn(text, open[open.length - 1]);
    if (declared !== null) open.push({ indent, ...declared });
    names.push(qualified(open));
  }
  return names;
}

/**
 * The names every line of these ranges sits in, or null where any sits in none, since a
 * claim naming only part of a change lets the rest collide unseen: lines decide instead.
 */
export function symbolsOfLines(
  source: string,
  ranges: readonly LineRange[],
  names: Array<string | null> = enclosingNames(source),
): string[] | null {
  const found = new Set<string>();
  for (const range of ranges) {
    for (let line = range.from; line <= range.to; line += 1) {
      const name = names[line - 1];
      // Past the end is a line an edit appends, named by where the file ends.
      const at = name === undefined ? names[names.length - 1] : name;
      if (at === null || at === undefined) return null;
      found.add(at);
    }
  }
  return [...found];
}

function declarationIn(
  text: string,
  inside: Opened | undefined,
): { name: string; holdsMethods: boolean } | null {
  for (const declaration of DECLARATIONS) {
    const name = declaration.pattern.exec(text)?.[1];
    if (name !== undefined) return { name, holdsMethods: declaration.holdsMethods };
  }
  if (inside?.holdsMethods !== true) return null;
  // A statement ending in `;` is a field or a call, never a method body.
  if (text.endsWith(';')) return null;
  const method = METHOD.exec(text)?.[1];
  if (method === undefined || NOT_A_METHOD.has(method)) return null;
  return { name: method, holdsMethods: false };
}

function qualified(open: readonly Opened[]): string | null {
  return open.length === 0 ? null : open.map((each) => each.name).join('.');
}

/** Columns of leading space, a tab counted as one level of four. */
function indentOf(row: string): number {
  let width = 0;
  for (const char of row) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 4;
    else break;
  }
  return width;
}
