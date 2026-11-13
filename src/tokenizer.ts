/**
 * Tokenizer for the jq language, based on the token set of the official
 * grammar (jqlang/jq src/parser.y + src/lexer.l):
 *
 *   %token IDENT FIELD BINDING LITERAL FORMAT REC ".." SETMOD "%=" EQ "=="
 *           NEQ "!=" DEFINEDOR "//" AS "as" DEF "def" MODULE "module"
 *           IMPORT "import" INCLUDE "include" IF "if" THEN "then" ELSE "else"
 *           ELSE_IF "elif" REDUCE "reduce" FOREACH "foreach" END "end"
 *           AND "and" OR "or" TRY "try" CATCH "catch" LABEL "label"
 *           BREAK "break" LOC "$__loc__" SETPIPE "|=" SETPLUS "+=" ...
 */

export class LexError extends Error {}

export type TokenType =
  | 'comment'
  | 'string'
  | 'number'
  | 'ident'
  | 'keyword'
  | 'constant'
  | 'variable'
  | 'format'
  | 'operator';

export interface Token {
  type: TokenType;
  text: string;
  /** 0-based line of the first character */
  line: number;
  /** 0-based column of the first character */
  col: number;
  /** set by the formatter: this '-' is a unary minus */
  unary?: boolean;
}

const KEYWORDS = new Set([
  'module', 'import', 'include', 'def', 'if', 'then', 'elif', 'else', 'end',
  'as', 'reduce', 'foreach', 'try', 'catch', 'label', 'break', 'and', 'or',
]);

const CONSTANTS = new Set(['true', 'false', 'null']);

// Multi-character operators must come before their prefixes.
const OPERATORS = [
  '?//', '|=', '//=', '+=', '-=', '*=', '/=', '%=',
  '//', '==', '!=', '<=', '>=', '..',
  '|', ',', ';', ':', '?', '(', ')', '[', ']', '{', '}',
  '=', '<', '>', '+', '-', '*', '/', '%', '.',
];

const isIdentStart = (c: string) => /[a-zA-Z_]/.test(c);
const isIdentChar = (c: string) => /[a-zA-Z_0-9]/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

/**
 * Scan a double-quoted jq string starting at s[start] === '"'.
 * Handles escapes and \(...) interpolation with full nesting
 * (strings inside interpolations, interpolations inside those strings, ...).
 * Returns the index of the closing quote.
 */
function scanString(s: string, start: number): number {
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === undefined) throw new LexError('unterminated escape');
      if (n === '(') {
        i = scanInterpolation(s, i + 2);
        continue;
      }
      i += 2;
      continue;
    }
    if (c === '"') return i;
    if (c === '\n') throw new LexError('raw newline inside string literal');
    i++;
  }
  throw new LexError('unterminated string literal');
}

/**
 * Scan an interpolation body; `i` points just past "\(".
 * Returns the index just past the matching ")".
 */
function scanInterpolation(s: string, i: number): number {
  let depth = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      i = scanString(s, i) + 1;
    } else if (c === '#') {
      while (i < s.length && s[i] !== '\n') i++;
    } else if (c === '(') {
      depth++;
      i++;
    } else if (c === ')') {
      depth--;
      i++;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  throw new LexError('unterminated string interpolation');
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 0;
  let lineStart = 0;

  const push = (type: TokenType, text: string) => {
    tokens.push({ type, text, line, col: i - lineStart });
  };

  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '#') {
      const begin = i;
      while (i < src.length && src[i] !== '\n') i++;
      push('comment', src.slice(begin, i));
      continue;
    }
    if (c === '"') {
      const end = scanString(src, i);
      push('string', src.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    if (c === '@') {
      const begin = i;
      i++;
      while (i < src.length && isIdentChar(src[i])) i++;
      push('format', src.slice(begin, i));
      continue;
    }
    if (c === '$') {
      const begin = i;
      i++;
      if (i < src.length && isIdentStart(src[i])) {
        while (i < src.length && isIdentChar(src[i])) i++;
        push('variable', src.slice(begin, i));
      } else {
        // lone '$' (e.g. the private $$$$name hack in jq's builtin.jq)
        push('operator', '$');
      }
      continue;
    }
    if (isDigit(c)) {
      const begin = i;
      while (i < src.length && isDigit(src[i])) i++;
      if (src[i] === '.') {
        i++;
        while (i < src.length && isDigit(src[i])) i++;
      }
      if (src[i] === 'e' || src[i] === 'E') {
        let j = i + 1;
        if (src[j] === '+' || src[j] === '-') j++;
        if (j < src.length && isDigit(src[j])) {
          i = j;
          while (i < src.length && isDigit(src[i])) i++;
        }
      }
      push('number', src.slice(begin, i));
      continue;
    }
    if (isIdentStart(c)) {
      const begin = i;
      while (i < src.length && isIdentChar(src[i])) i++;
      const word = src.slice(begin, i);
      if (KEYWORDS.has(word)) push('keyword', word);
      else if (CONSTANTS.has(word)) push('constant', word);
      else push('ident', word);
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      push('operator', op);
      i += op.length;
      continue;
    }
    throw new LexError(`unexpected character ${JSON.stringify(c)} at line ${line + 1}`);
  }
  return tokens;
}

/** Opening brackets paired with their closing counterparts. */
const BRACKET_PAIR: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

export function isOpenBracket(t: Token): boolean {
  return t.type === 'operator' && t.text in BRACKET_PAIR;
}

export function isCloseBracket(t: Token): boolean {
  return t.type === 'operator' && [')', ']', '}'].includes(t.text);
}

/**
 * Map each opening bracket token index to its matching closing bracket
 * token index. Throws on unbalanced brackets.
 */
export function matchBrackets(tokens: Token[]): Map<number, number> {
  const match = new Map<number, number>();
  const stack: number[] = [];
  tokens.forEach((t, i) => {
    if (isOpenBracket(t)) {
      stack.push(i);
    } else if (isCloseBracket(t)) {
      const open = stack.pop();
      if (open === undefined) throw new LexError(`unbalanced '${t.text}'`);
      if (BRACKET_PAIR[tokens[open].text] !== t.text) {
        throw new LexError(`mismatched bracket '${tokens[open].text}'...'${t.text}'`);
      }
      match.set(open, i);
    }
  });
  if (stack.length > 0) throw new LexError(`unbalanced '${tokens[stack[stack.length - 1]].text}'`);
  return match;
}
