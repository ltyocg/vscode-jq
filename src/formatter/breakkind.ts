/**
 * 断点词汇表：decide（layout.ts 的 decideBreak）与 predict（组风格、
 * 元素断行等源码推断）共用的唯一「哪些边是合法断点」分类。本模块
 * 只回答「这是哪一种断点」，不回答「要不要断」—— 何时断取决于
 * 各引擎自己的策略（组风格、源码换行、行宽）。
 *
 * decide 与 predict 对个别种类有意不对称，消费点各自过滤：
 *  - def：decide 在悬挂式开括号行上与未展开组内不断行（见
 *    decideBreak），predict 的 groupBreaks 以 k > i + 1 排除紧跟
 *    开括号的 def（悬挂式例外）；
 *  - afterClause：predict 把 'end' 也算触发 token（end 之后换行
 *    也是组内断行），decide 只认 then/elif/else/catch（'end' 之后
 *    不另起分支行）；
 *  - afterColon：predict 一律视为断点，decide 再按 def 记账与所在
 *    括号种类细分（def 头冒号要求全部组展开，对象冒号只要求最内层
 *    大括号组展开，切片冒号不断行）。
 */
import { CLAUSE_KEYWORDS, CLOSERS, LINE_BREAK_BINOPS, OPENERS, type FmtToken } from './spacing'
import type { TokenStream } from './tokens'

/**
 * 断点种类。前六种断在 tokens[k] 之前（k 自身是断点 token），
 * 后四种断在 tokens[k] 之后（k 是触发 token）。
 */
export type BreakKind =
  | 'pipe' // '|' 之前：行首管道，比上下文深一层
  | 'closer' // 闭括号之前：按组风格回缩
  | 'binop' // 可行首双目运算符之前：与本行同层
  | 'leadSep' // ','/';' 之前：悬挂组内前导分隔符，对齐开括号列
  | 'clause' // 子句关键字之前（非对象键）：回到 if/try 所在行的行首
  | 'def' // def 之前（非对象键）：总起新行
  | 'afterSep' // ','/';' 之后：元素另起一行
  | 'afterColon' // ':' 之后：decide 再按 def 记账/括号种类细分
  | 'afterOpener' // 分隔式展开组开括号之后：首元素另起一行
  | 'afterClause' // 子句关键字之后：分支内容另起一行

/** 可作行首断点的双目运算符（一元 '-' 除外） */
export function isLineBreakBinop(t: FmtToken): boolean {
  return t.type === 'operator' && LINE_BREAK_BINOPS.has(t.text) && !(t.text === '-' && t.unary)
}

/**
 * tokens[k] 自身作为断点 token（断点在 k 之前）的种类；null = 不是
 * 断点。对象键关键字（`{if: 1}`）不算子句/def 断点。
 */
export function breakBefore(st: TokenStream, k: number): BreakKind | null {
  const tk = st.tokens[k]
  if (tk.type === 'operator') {
    if (tk.text === '|') return 'pipe'
    if (CLOSERS.has(tk.text)) return 'closer'
    if (isLineBreakBinop(tk)) return 'binop'
    if (tk.text === ',' || tk.text === ';') return 'leadSep'
    return null
  }
  if (tk.type === 'keyword' && !st.objectKey[k]) {
    if (CLAUSE_KEYWORDS.has(tk.text)) return 'clause'
    if (tk.text === 'def' && k > 0) return 'def'
  }
  return null
}

/**
 * tokens[k] 之后是断点（k 是触发 token）的种类；null = 不是。
 * 对象键关键字仍是 afterClause ——「then: 之后换行」在 predict 与
 * decide 两侧都不加对象键守卫（见上方不对称清单之外的既有行为）。
 */
export function breakAfter(st: TokenStream, k: number): BreakKind | null {
  const tk = st.tokens[k]
  if (tk.type === 'operator') {
    if (tk.text === ',' || tk.text === ';') return 'afterSep'
    if (tk.text === ':') return 'afterColon'
    if (OPENERS.has(tk.text)) return 'afterOpener'
    return null
  }
  if (tk.type === 'keyword' && CLAUSE_KEYWORDS.has(tk.text)) return 'afterClause'
  return null
}
