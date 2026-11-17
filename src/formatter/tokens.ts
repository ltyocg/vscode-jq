/**
 * token 流层：把词法 token 一次性整理成格式化器内部使用的 token 流 ——
 * 一元负号标注、括号配对、关键字作对象键的判定，以及全部行号位置
 * 算术（token 结束行、相邻 token 间的源码换行数）。本文件只有纯
 * 函数与一次性预处理，不做任何断行决策（那是 layout.ts 的事）。
 */
import type { Token } from '../tokenizer'
import { FormatError } from './api'
import { annotateUnary, isObjectKey, type FmtToken } from './spacing'

export function countNewlines(s: string): number {
  let n = 0
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++
  return n
}

/** token 在其结束行上的尾后列号（0 起，不含）；多行 token 取最后一行 */
export function endCol(t: FmtToken): number {
  const lastNl = t.text.lastIndexOf('\n')
  return lastNl >= 0 ? t.text.length - lastNl - 1 : t.col + t.text.length
}

/** token 的结束行号（首行行号 + 自身跨行数） */
export function endLine(t: FmtToken): number {
  return t.line + countNewlines(t.text)
}

/** prev 与 tk 之间的源码换行数（0 表示同行，负数不可能出现于合法词法） */
export function newlinesBetween(prev: FmtToken, tk: FmtToken): number {
  return tk.line - endLine(prev)
}

const BRACKET_PAIR: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/**
 * 为每个开括号 token 求出配对的闭括号 token 下标；
 * 括号不配对或类型不匹配时抛 FormatError。
 */
export function matchBrackets(tokens: FmtToken[]): Map<number, number> {
  const match = new Map<number, number>()
  const stack: number[] = []
  tokens.forEach((t, i) => {
    if (t.type === 'operator' && t.text in BRACKET_PAIR) {
      stack.push(i)
    } else if (t.type === 'operator' && (t.text === ')' || t.text === ']' || t.text === '}')) {
      const open = stack.pop()
      if (open === undefined) throw new FormatError(`cannot format: unbalanced '${t.text}'`)
      if (BRACKET_PAIR[tokens[open].text] !== t.text) {
        throw new FormatError(
          `cannot format: mismatched bracket '${tokens[open].text}'...'${t.text}'`
        )
      }
      match.set(open, i)
    }
  })
  if (stack.length > 0) {
    throw new FormatError(`cannot format: unbalanced '${tokens[stack[stack.length - 1]].text}'`)
  }
  return match
}

/**
 * 断点搜索的向前看上限（token 数）。从某个 token 起最多看这么多
 * token 仍找不到合法断点，就把直到文件尾的余下部分视为一个片段：
 * 它会被当作不可分割的单行输出（括号组内部仍照常展开），以此
 * 避免对病态长输入做平方级扫描。
 */
export const MAX_SEGMENT_LOOKAHEAD = 200

/**
 * 词法 token 的一次性注释化。tokens 是标好一元负号的 token 序列；
 * match 把每个开括号下标映射到配对闭括号下标；objectKey[k] 标记
 * tokens[k] 是否为作对象键的关键字（如 `{if: 1}`，见 spacing.ts 的
 * isObjectKey）。三者都是纯 token 派生信息，预算一次、处处复用。
 */
export interface TokenStream {
  readonly tokens: readonly FmtToken[]
  readonly match: ReadonlyMap<number, number>
  readonly objectKey: readonly boolean[]
}

/** 从词法 token 构建 token 流；括号不配对时抛 FormatError */
export function buildStream(raw: Token[]): TokenStream {
  const tokens = annotateUnary(raw)
  const match = matchBrackets(tokens)
  const objectKey = tokens.map((_, k) => isObjectKey(tokens, k))
  return { tokens, match, objectKey }
}
