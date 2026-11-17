/**
 * jq 语言的词法分析器，token 集合与官方文法一致
 * （jqlang/jq 的 src/parser.y + src/lexer.l）：
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
  /** 首字符所在行（0 起） */
  line: number
  /** 首字符所在列（0 起） */
  col: number
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

// 多字符运算符必须排在它的单字符前缀之前。
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
 * 扫描从 s[start](s[start] === '#')开始的注释。
 *
 * 依据 jq 手册：'#' 开启一段到行尾为止的注释；但当行尾前面有
 * 奇数个反斜杠时，下一行也属于这段注释（shebang 的 `# \` 技巧
 * 正依赖于此）。返回终止换行符的下标，输入结束时返回 s.length。
 */
function scanComment(s: string, start: number): number {
  let i = start
  for (;;) {
    let eol = i
    while (eol < s.length && s[eol] !== '\n') eol++
    if (eol >= s.length) return eol
    // 统计该行末尾（不含可选的 \r）的连续反斜杠个数
    let k = eol
    if (k > i && s[k - 1] === '\r') k--
    let backslashes = 0
    while (k > i && s[k - 1] === '\\') {
      backslashes++
      k--
    }
    if (backslashes % 2 === 0) return eol
    i = eol + 1 // 奇数个：下一行也是注释
  }
}

/**
 * 扫描从 s[start](s[start] === '"')开始的双引号字符串，处理
 * 转义与 \(…) 插值的完整嵌套（插值里的字符串、字符串里的插值……）。
 * 返回闭引号的下标。
 *
 * jq 字符串字面量里允许裸换行（真实词法器 IN_QQSTRING 的内容规则
 * `[^\\"]+` 能匹配换行，见 jqlang/jq src/lexer.l），所以 jqjq 的
 * `_builtins_src` 那类多行字符串会扫描成单个 token。
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
 * 扫描插值体；i 指向 "\(" 之后。返回越过配对 ')' 的下标。
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
 * 扫描从 s[i] 开始的数字字面量（s[i] 是数字，或后跟数字的 '.'
 * —— jq 接受 '.5' 这种前导点小数）。返回越过字面量的下标。
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

  // begin 是 token 首字符的下标：col 必须从它算起。
  // 调用时若已把 i 推进到 token 末尾（多字符 token 的扫描循环），
  // 必须显式传入 begin，否则会把结束位置记成起始列。
  const push = (type: TokenType, text: string, begin = i) => {
    tokens.push({ type, text, line, col: begin - lineStart })
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
      const end = scanComment(src, begin)
      const text = src.slice(begin, end)
      push('comment', text, begin)
      i = end
      // 该 token 可能跨行（反斜杠续行）；同步行号，让后续 token
      // 报告正确的位置
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
      push('format', src.slice(begin, i), begin)
      continue
    }
    if (c === '$') {
      const begin = i
      i++
      if (i < src.length && isIdentStart(src[i])) {
        while (i < src.length && isIdentChar(src[i])) i++
        push('variable', src.slice(begin, i), begin)
      } else {
        // 裸 '$'（jq builtin.jq 里私有的 $$$$name 技巧）
        push('operator', '$')
      }
      continue
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      const begin = i
      i = scanNumber(src, i)
      push('number', src.slice(begin, i), begin)
      continue
    }
    if (isIdentStart(c)) {
      const begin = i
      while (i < src.length && isIdentChar(src[i])) i++
      const word = src.slice(begin, i)
      if (KEYWORDS.has(word)) push('keyword', word, begin)
      else if (CONSTANTS.has(word)) push('constant', word, begin)
      else push('ident', word, begin)
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
