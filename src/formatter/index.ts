/**
 * jq 程序格式化器 —— 公共入口。
 *
 * 一个只处理空白的、结构感知的排版器,基于 jq 官方文法
 * (jqlang/jq src/parser.y)构建。它从不改动 token 文本,
 * 只决定空格、换行与缩进。
 *
 * 风格规则:
 *  - 每层缩进 indentSize 个空格(默认 2)
 *  - 源码有换行或行宽超出 printWidth 时,管道以下一行行首 '|'
 *    (缩进 +1)的方式断行
 *  - 对象/数组/括号组在源码有内部换行、包含注释或超出 printWidth
 *    时展开(每元素一行)
 *  - 用户的换行在合法断点处保留(';' 之后、def 前后、if/try 子句
 *    附近、'|' 之前),其余位置折叠
 *  - 注释保留:独立注释独占一行,行尾注释留在行尾
 *
 * 内部模块:
 *  - api.ts      选项与错误类型(叶子模块,避免循环依赖)
 *  - spacing.ts  纯空白规则(token 间距、一元负号标注)
 *  - emit.ts     行发射器(拼行、缩进、行宽)
 *  - layout.ts   布局决策(断行、展开、语法上下文栈、括号配对)
 */

import { LexError, tokenize, type Token } from '../tokenizer'
import { FormatError, defaultFormatOptions, type FormatOptions } from './api'
import { LineBuilder } from './emit'
import { Layout, matchBrackets } from './layout'
import { annotateUnary } from './spacing'

export { FormatError, defaultFormatOptions } from './api'
export type { FormatOptions } from './api'

export function formatJq(src: string, options?: Partial<FormatOptions>): string {
  if (src.trim() === '') return src
  const opts: FormatOptions = { ...defaultFormatOptions, ...options }

  let raw: Token[]
  try {
    raw = tokenize(src)
  } catch (e) {
    if (e instanceof LexError) throw new FormatError(`cannot format: ${e.message}`)
    throw e
  }
  if (raw.length === 0) return src

  // 预处理:标注一元负号、配对括号。词法错误与结构错误统一以
  // FormatError 抛出,调用方(extension.ts)据此拒绝改动文件。
  const tokens = annotateUnary(raw)
  const match = matchBrackets(tokens)

  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const out = new LineBuilder(opts.indentSize)
  new Layout(tokens, match, opts, out).run()
  out.trimTrailingBlankLines()
  return out.join(eol) + eol
}
