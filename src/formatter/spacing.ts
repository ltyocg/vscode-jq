/**
 * 纯空白规则：相邻 token 之间的水平间距。本文件只有纯函数，
 * 不持有状态，也不涉及断行与缩进（那两件事分别归 printer.ts 与
 * emit.ts）。打印器的发射路径与宽度测量（width.ts 的 flatWidth）
 * 消费同一份规则，两侧才不会漂移。
 */
import { isDotFieldName, type Token } from '../tokenizer'

/** 开括号 */
const OPENERS = new Set(['(', '[', '{'])

/** 闭括号 */
const CLOSERS = new Set([')', ']', '}'])

/**
 * 格式化器内部的 token：在 tokenizer 的纯词法信息之上，额外标注了
 * 每个 '-'/'+' 是否为一元（由解析器的一元词项结构给出，见
 * parser/parse.ts 的 unaryAt）。
 */
export interface FmtToken extends Token {
  unary: boolean
}

/**
 * 能作为操作数结尾的 token：其后紧跟的 '.' 或 '[' 应当紧贴（调用与
 * 下标括号因此区别于开启新表达式的组开括号）。
 */
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
  // 3. 点号之后：'.foo'、'."foo"'、'.['；关键字/常量字段名（'.catch'、'.end'、'.null'、
  //    '$if_.elif'）按源码邻接保留 —— '.catch' 与 '. catch'、'.end' 与
  //    '. end' 语义不同（字段访问 vs 身份后跟子句关键字），归一化任一
  //    方向都会改写程序
  if (prev.type === 'operator' && (prev.text === '.' || prev.text === '..')) {
    if (
      next.type === 'ident' ||
      next.type === 'string' ||
      (next.type === 'operator' && next.text === '[')
    ) {
      return 'none'
    }
    if (isDotFieldName(prev, next)) return 'none'
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
