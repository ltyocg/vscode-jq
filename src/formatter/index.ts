/**
 * jq 程序格式化器 —— 公共入口。
 *
 * 管线：解析（src/formatter/parser/，文法事实来源 jqlang/jq 的
 * parser.y）→ AST → 打印（printer.ts，按 STYLE.md 的规范）。
 *
 * 只处理空白的、结构感知的排版器：从不改动 token 文本；唯一允许增删
 * token 的位置是对象构造的尾随逗号，由 trailingComma 选项控制（默认
 * 'never'＝一律去掉，jq 语法中对象构造是尾随逗号唯一合法的位置）。
 * 风格规范见 STYLE.md；要点：
 *  - 链（管道与双目运算符，含 and/or）断行时行首运算符，续行取
 *    indentSize 整数倍的缩进，不做锚点列对齐；
 *  - 括号组「展开或单行」二选一：作者展开意图保留、自身层级有注释、
 *    平铺超宽或元素结构性多行时展开；
 *  - if/try 子句关键字回到关键字所在缩进；
 *  - 空行保留（上限 2）、绝不新增；注释保留（独立注释属下一行，
 *    行尾注释留行尾）；
 *  - `.` 与关键字字段名之间的源码邻接保留（语义守护）。
 *
 * 输入必须是语法合法的 jq：词法或解析错误抛 FormatError，扩展入口
 * 据此拒绝改动文件。
 *
 * 内部模块（依赖自上而下，无环）：
 *  - api.ts       选项与错误类型（叶子模块）
 *  - parser/      AST 与递归下降 + Pratt 解析器
 *  - spacing.ts   纯空白规则（token 间距）
 *  - width.ts     宽度测量与结构性多行判定
 *  - emit.ts      行发射器（拼行、缩进、行宽）
 *  - printer.ts   AST 打印器（断行、缩进、注释与空行冲刷）
 */
import { parseProgram, ParseError } from './parser/parse'
import { printProgramResult } from './printer'
import { LexError } from '../tokenizer'
import { FormatError, defaultFormatOptions, type FormatOptions } from './api'

export { FormatError, defaultFormatOptions } from './api'
export type { FormatOptions, TrailingCommaMode } from './api'

export function formatJq(src: string, options?: Partial<FormatOptions>): string {
  if (src.trim() === '') return src
  const opts: FormatOptions = { ...defaultFormatOptions, ...options }

  let parsed: ReturnType<typeof parseProgram>
  try {
    parsed = parseProgram(src)
  } catch (e) {
    if (e instanceof LexError || e instanceof ParseError) {
      const at = e instanceof ParseError ? ` (line ${e.line + 1})` : ''
      throw new FormatError(`cannot format: ${e.message}${at}`)
    }
    throw e
  }
  if (parsed.real.length === 0) return src

  return printProgramResult(parsed, opts)
}
