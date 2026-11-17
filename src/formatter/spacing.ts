/**
 * 纯空白规则：相邻 token 之间的水平间距、一元负号标注、
 * 关键字作对象键的判定。本文件只有纯函数，不持有状态，
 * 也不涉及断行与缩进（那两件事分别归 layout.ts 与 emit.ts）。
 */

import type { Token } from '../tokenizer'

/** if/try 的子句关键字，断行决策中被单独对待 */
export const CLAUSE_KEYWORDS = new Set(['then', 'elif', 'else', 'end', 'catch'])

/** 开括号 */
export const OPENERS = new Set(['(', '[', '{'])

/** 闭括号 */
export const CLOSERS = new Set([')', ']', '}'])

/**
 * 全部双目运算符（含 '|' 与 '?//'）：'-' 紧跟其后时只能是一元负号。
 * 单一事实来源 —— 其余运算符集合一律从这里派生，不再各自维护清单。
 */
const BINOPS = [
  '|',
  '//',
  '?//',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '|=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '//='
] as const

const BINOP_SET = new Set<string>(BINOPS)

/**
 * 可作行首断点的双目运算符：源码换行处保留、超宽时以行首运算符
 * 折行。'|' 另有行首管道规则，'?//' 是解构语法，均不在其中。
 */
export const LINE_BREAK_BINOPS = new Set<string>(
  BINOPS.filter((op) => op !== '|' && op !== '?//')
)

/**
 * 格式化器内部的 token：在 tokenizer 的纯词法信息之上，额外标注了
 * 每个 '-' 是否为一元负号（见 annotateUnary）。
 */
export interface FmtToken extends Token {
  unary: boolean
}

/**
 * 标注每个 '-' 是一元还是双目，返回新数组，不修改输入。
 * 一元负号只影响间距（'-1' 紧贴操作数，'1 - 2' 两侧留空格），
 * 是排版问题而不是词法问题，所以由格式化器完成；tokenizer 的
 * Token 保持纯词法信息。
 */
export function annotateUnary(tokens: Token[]): FmtToken[] {
  let prev: Token | undefined
  return tokens.map((t) => {
    // 注释不参与语法上下文
    if (t.type === 'comment') return { ...t, unary: false }
    const ft: FmtToken = {
      ...t,
      unary: t.type === 'operator' && t.text === '-' && isPrefixPosition(prev)
    }
    prev = ft
    return ft
  })
}

/**
 * tokens[k] 是否是作对象键的关键字，如 `{if: 1, end: 2}` ——
 * jq 保留这些字但仍然允许它们作键。这类关键字不得触发子句断行或
 * 子句状态：`{if: …}` 不开启 if 上下文，`{end: …}` 不关闭任何
 * 上下文，`{def: …}` 不是定义。子句关键字在其他位置不可能合法地
 * 后跟 ':'，所以这个向前看是没有歧义的。
 */
export function isObjectKey(tokens: readonly FmtToken[], k: number): boolean {
  const t = tokens[k]
  const n = tokens[k + 1]
  return t.type === 'keyword' && !!n && n.type === 'operator' && n.text === ':'
}

/** 能作为操作数结尾的 token：其后紧跟的 '.' 或 '[' 应当紧贴。 */
function isOperandEnd(t: Token | undefined): boolean {
  if (!t) return false
  switch (t.type) {
    case 'ident':
    case 'number':
    case 'string':
    case 'variable':
    case 'format':
    case 'constant':
      return true
    case 'operator':
      return t.text === ')' || t.text === ']' || t.text === '}' || t.text === '?'
    default:
      return false
  }
}

/** t 之后紧跟的 '-' 是否必然是一元负号。 */
function isPrefixPosition(t: Token | undefined): boolean {
  if (!t) return true // 文件开头
  if (t.type === 'operator') {
    return (
      OPENERS.has(t.text) ||
      t.text === ',' ||
      t.text === ';' ||
      t.text === ':' ||
      t.text === '$' ||
      BINOP_SET.has(t.text)
    )
  }
  if (t.type === 'keyword') return t.text !== 'end' // `end - 1` 是双目
  return false
}

/**
 * 同一行上两个相邻 token 之间的水平间距。enclosing 是最内层未闭合
 * 的开括号字符（'(' / '[' / '{'），语句级为 '' —— 用于区分对象冒号
 * ('{a: 1}')与切片冒号('.[2:5]')。
 */
export function gapBetween(prev: FmtToken, next: FmtToken, enclosing: string): 'none' | 'space' {
  // 1. 闭括号 / 分隔符 / 后缀 '?' / 冒号之前不留空格
  if (
    next.type === 'operator' &&
    (CLOSERS.has(next.text) ||
      next.text === ',' ||
      next.text === ';' ||
      next.text === '?' ||
      next.text === ':')
  ) {
    return 'none'
  }
  // 2. 开括号之后直接紧跟
  if (prev.type === 'operator' && OPENERS.has(prev.text)) return 'none'
  // 3. 点号之后：'.foo'、'."foo"'、'.['
  if (prev.type === 'operator' && (prev.text === '.' || prev.text === '..')) {
    if (
      next.type === 'ident' ||
      next.type === 'string' ||
      (next.type === 'operator' && next.text === '[')
    ) {
      return 'none'
    }
    return 'space'
  }
  // 4. 一元负号紧贴操作数：'-1'、'-(.a)'、'-.score'
  if (prev.type === 'operator' && prev.text === '-' && prev.unary) return 'none'
  // 5. 字段 / 下标链紧贴：'.a.b'、'(.f).g'、'first[0]'、'$x[0]'
  if (next.type === 'operator' && (next.text === '.' || next.text === '[' || next.text === '..')) {
    return isOperandEnd(prev) ? 'none' : 'space'
  }
  // 6. 函数调用：'map('
  if (next.type === 'operator' && next.text === '(' && prev.type === 'ident') {
    return 'none'
  }
  // 7. 冒号间距：'{a: 1}' 与 'def f: …' 加空格，切片 '.[2:5]' 不加
  if (prev.type === 'operator' && prev.text === ':') {
    return enclosing === '[' ? 'none' : 'space'
  }
  // 8. 裸 '$' 前缀（jq builtin.jq 里私有的 $$$$name 技巧）
  if (prev.type === 'operator' && prev.text === '$') return 'none'
  if (
    next.type === 'operator' &&
    next.text === '$' &&
    prev.type === 'operator' &&
    prev.text === '$'
  ) {
    return 'none'
  }
  return 'space'
}
