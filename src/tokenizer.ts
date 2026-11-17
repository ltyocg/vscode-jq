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
  | 'operator'

export interface Token {
  type: TokenType
  text: string
  /** 0-based line of the first character */
  line: number
  /** 0-based column of the first character */
  col: number
  /** set by the formatter: this '-' is a unary minus */
  unary?: boolean
}

const KEYWORDS = new Set([
  'module',
  'import',
  'include',
  'def',
  'if',
  'then',
  'elif',
  'else',
  'end',
  'as',
  'reduce',
  'foreach',
  'try',
  'catch',
  'label',
  'break',
  'and',
  'or'
])

const CONSTANTS = new Set(['true', 'false', 'null'])

// Multi-character operators must come before their prefixes.
const OPERATORS = [
  '?//',
  '|=',
  '//=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '//',
  '==',
  '!=',
  '<=',
  '>=',
  '..',
  '|',
  ',',
  ';',
  ':',
  '?',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '.'
]

const isIdentStart = (c: string) => /[a-zA-Z_]/.test(c)
const isIdentChar = (c: string) => /[a-zA-Z_0-9]/.test(c)
const isDigit = (c: string) => c >= '0' && c <= '9'

/**
 * Scan a `#` comment starting at s[start] === '#'.
 *
 * Per the jq manual: a `#` starts a comment that runs to the end of the
 * line, but when the end of the line is preceded by an odd number of
 * backslash characters, the following line is part of the comment as
 * well (this is what makes the `# \` shebang trick work). Returns the
 * index of the terminating newline, or s.length at end of input.
 */
function scanComment(s: string, start: number): number {
  let i = start
  for (;;) {
    let eol = i
    while (eol < s.length && s[eol] !== '\n') eol++
    if (eol >= s.length) return eol
    // Count the run of backslashes ending this line (before an optional \r).
    let k = eol
    if (k > i && s[k - 1] === '\r') k--
    let backslashes = 0
    while (k > i && s[k - 1] === '\\') {
      backslashes++
      k--
    }
    if (backslashes % 2 === 0) return eol
    i = eol + 1 // odd run: the next line is comment too
  }
}

/**
 * Scan a double-quoted jq string starting at s[start] === '"'.
 * Handles escapes and \(...) interpolation with full nesting
 * (strings inside interpolations, interpolations inside those strings, ...).
 * Returns the index of the closing quote.
 *
 * Raw newlines are legal inside jq string literals (the real lexer's
 * IN_QQSTRING content rule `[^\\"]+` matches them — see jqlang/jq
 * src/lexer.l), so multi-line strings like jqjq's `_builtins_src` scan
 * as a single token.
 */
function scanString(s: string, start: number): number {
  let i = start + 1
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') {
      const n = s[i + 1]
      if (n === undefined) throw new LexError('unterminated escape')
      if (n === '(') {
        i = scanInterpolation(s, i + 2)
        continue
      }
      i += 2
      continue
    }
    if (c === '"') return i
    i++
  }
  throw new LexError('unterminated string literal')
}

/**
 * Scan an interpolation body; `i` points just past "\(".
 * Returns the index just past the matching ")".
 */
function scanInterpolation(s: string, i: number): number {
  let depth = 1
  while (i < s.length) {
    const c = s[i]
    if (c === '"') {
      i = scanString(s, i) + 1
    } else if (c === '#') {
      i = scanComment(s, i)
    } else if (c === '(') {
      depth++
      i++
    } else if (c === ')') {
      depth--
      i++
      if (depth === 0) return i
    } else {
      i++
    }
  }
  throw new LexError('unterminated string interpolation')
}

/**
 * Scan a number literal starting at s[i] (a digit, or '.' followed by a
 * digit — jq accepts leading-dot floats like `.5`). Returns the index
 * just past the literal.
 */
function scanNumber(s: string, i: number): number {
  if (s[i] === '.') {
    i++
    while (i < s.length && isDigit(s[i])) i++
  } else {
    while (i < s.length && isDigit(s[i])) i++
    if (s[i] === '.') {
      i++
      while (i < s.length && isDigit(s[i])) i++
    }
  }
  if (s[i] === 'e' || s[i] === 'E') {
    let j = i + 1
    if (s[j] === '+' || s[j] === '-') j++
    if (isDigit(s[j])) {
      i = j
      while (i < s.length && isDigit(s[i])) i++
    }
  }
  return i
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let line = 0
  let lineStart = 0

  const push = (type: TokenType, text: string) => {
    tokens.push({ type, text, line, col: i - lineStart })
  }

  while (i < src.length) {
    const c = src[i]
    if (c === '\n') {
      i++
      line++
      lineStart = i
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '#') {
      const begin = i
      i = scanComment(src, i)
      push('comment', src.slice(begin, i))
      // The token may span lines (backslash continuation); catch up the
      // line counter so later tokens report correct positions.
      const text = src.slice(begin, i)
      const lastNl = text.lastIndexOf('\n')
      if (lastNl >= 0) {
        for (const ch of text) if (ch === '\n') line++
        lineStart = begin + lastNl + 1
      }
      continue
    }
    if (c === '"') {
      const end = scanString(src, i)
      push('string', src.slice(i, end + 1))
      i = end + 1
      continue
    }
    if (c === '@') {
      const begin = i
      i++
      while (i < src.length && isIdentChar(src[i])) i++
      push('format', src.slice(begin, i))
      continue
    }
    if (c === '$') {
      const begin = i
      i++
      if (i < src.length && isIdentStart(src[i])) {
        while (i < src.length && isIdentChar(src[i])) i++
        push('variable', src.slice(begin, i))
      } else {
        // lone '$' (e.g. the private $$$$name hack in jq's builtin.jq)
        push('operator', '$')
      }
      continue
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      const begin = i
      i = scanNumber(src, i)
      push('number', src.slice(begin, i))
      continue
    }
    if (isIdentStart(c)) {
      const begin = i
      while (i < src.length && isIdentChar(src[i])) i++
      const word = src.slice(begin, i)
      if (KEYWORDS.has(word)) push('keyword', word)
      else if (CONSTANTS.has(word)) push('constant', word)
      else push('ident', word)
      continue
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i))
    if (op) {
      push('operator', op)
      i += op.length
      continue
    }
    throw new LexError(`unexpected character ${JSON.stringify(c)} at line ${line + 1}`)
  }
  return tokens
}

/** Opening brackets paired with their closing counterparts. */
const BRACKET_PAIR: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

export function isOpenBracket(t: Token): boolean {
  return t.type === 'operator' && t.text in BRACKET_PAIR
}

export function isCloseBracket(t: Token): boolean {
  return t.type === 'operator' && [')', ']', '}'].includes(t.text)
}

/**
 * Map each opening bracket token index to its matching closing bracket
 * token index. Throws on unbalanced brackets.
 */
export function matchBrackets(tokens: Token[]): Map<number, number> {
  const match = new Map<number, number>()
  const stack: number[] = []
  tokens.forEach((t, i) => {
    if (isOpenBracket(t)) {
      stack.push(i)
    } else if (isCloseBracket(t)) {
      const open = stack.pop()
      if (open === undefined) throw new LexError(`unbalanced '${t.text}'`)
      if (BRACKET_PAIR[tokens[open].text] !== t.text) {
        throw new LexError(`mismatched bracket '${tokens[open].text}'...'${t.text}'`)
      }
      match.set(open, i)
    }
  })
  if (stack.length > 0) throw new LexError(`unbalanced '${tokens[stack[stack.length - 1]].text}'`)
  return match
}
