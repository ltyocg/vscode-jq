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
 *    也是组内断行），decide 认 then/elif/else/catch/try（'end' 之后
 *    不另起分支行）；try 的分支缩进在其发射时记入 bodyIndent，
 *    predict 当作普通 afterClause；
 *  - afterColon：predict 一律视为断点，decide 再按 def 记账与所在
 *    括号种类细分（def 头冒号要求全部组展开，对象冒号只要求最内层
 *    大括号组展开，切片冒号不断行）；
 *  - reduce：无超宽补断，只在源码确有换行时才真的断行 ——
 *    measure 的 findSegmentEnd 与 predict 的 firstSeparator 仅在
 *    换行存在时把它当片段边界，未换行时片段要跨过 reduce 分组
 *    继续量宽；
 *  - afterBinop：decide 与 predict 两侧都只认源码换行（不补断）；
 *  - afterAs：两侧同样只认源码换行；decide 侧的缩进锚到 as 左侧
 *    操作数的起始列（layout 的 boundExprStartCol 回溯），predict 侧
 *    只计「会不会断」，firstSeparator 里它先于嵌套组递归终结开括号
 *    行预算（模式自身常是会断行的括号组）。
 */
import { CLAUSE_KEYWORDS, CLOSERS, LINE_BREAK_BINOPS, OPENERS, type FmtToken } from './spacing'
import { matchBackward, type TokenStream } from './tokens'

/**
 * 子句关键字归属的子句栈种类：'catch' 属 try，其余（then/elif/else/
 * end）属 if。断行决策与注释缩进两处共用。
 */
export function clauseStackKind(text: string): 'if' | 'try' {
  return text === 'catch' ? 'try' : 'if'
}

/**
 * 断点种类。前七种断在 tokens[k] 之前（k 自身是断点 token），
 * 后六种断在 tokens[k] 之后（k 是触发 token）。
 */
export type BreakKind =
  | 'pipe' // '|' 之前：行首管道，比上下文深一层
  | 'closer' // 闭括号之前：按组风格回缩
  | 'binop' // 可行首双目运算符（含关键字 and/or，非对象键）之前：与本行同层
  | 'leadSep' // ','/';' 之前：悬挂组内前导分隔符，对齐开括号列
  | 'clause' // 子句关键字之前（非对象键）：回到 if/try 所在行的行首
  | 'def' // def 之前（非对象键）：总起新行
  | 'reduce' // reduce/foreach 分组的 '(' 之前（as 绑定模式之后）：深一层
  | 'afterSep' // ','/';' 之后：元素另起一行
  | 'afterColon' // ':' 之后：decide 再按 def 记账/括号种类细分
  | 'afterOpener' // 分隔式展开组开括号之后：首元素另起一行
  | 'afterClause' // 子句关键字（含 try 的 body 触发）之后：分支内容另起一行
  | 'afterBinop' // 双目运算符/管道之后（尾随风格）：操作数另起一行
  | 'afterAs' // 'as' 之后（尾随风格）：绑定模式另起一行，比操作数起始列深一层

/** 可作行首断点的双目运算符（一元 '-' 除外） */
export function isLineBreakBinop(t: FmtToken): boolean {
  return t.type === 'operator' && LINE_BREAK_BINOPS.has(t.text) && !(t.text === '-' && t.unary)
}

/**
 * tokens[k] 的 '(' 是否紧跟 as 绑定模式 —— 即 reduce/foreach 的分组
 * 开括号（管道绑定 `as $x |` 之后只会是 '|'，析构备选 `?//` 不以
 * '(' 收尾，故「模式之后直接 '('」唯一对应 reduce/foreach）。模式
 * 形如 '$var' 或 '[…]'（嵌套析构由括号配对回溯到最外层 '['）。
 */
function afterAsPattern(st: TokenStream, k: number): boolean {
  const prev = st.tokens[k - 1]
  if (prev === undefined) return false
  let j: number
  if (prev.type === 'variable') {
    j = k - 2
  } else if (prev.type === 'operator' && prev.text === ']') {
    const open = matchBackward(st.tokens, k - 1)
    if (open < 0) return false
    j = open - 1
  } else {
    return false
  }
  const asTok = st.tokens[j]
  return asTok !== undefined && asTok.type === 'keyword' && asTok.text === 'as'
}

/**
 * tokens[k] 自身作为断点 token（断点在 k 之前）的种类；null = 不是
 * 断点。对象键关键字（`{if: 1}`、`{or: 1}`）与点号字段名（`.catch`、
 * `$if_.elif`）不算子句/def/双目断点。
 */
export function breakBefore(st: TokenStream, k: number): BreakKind | null {
  const tk = st.tokens[k]
  if (tk.type === 'operator') {
    if (tk.text === '|') return 'pipe'
    if (CLOSERS.has(tk.text)) return 'closer'
    if (isLineBreakBinop(tk)) return 'binop'
    if (tk.text === ',' || tk.text === ';') return 'leadSep'
    if (tk.text === '(' && afterAsPattern(st, k)) return 'reduce'
    return null
  }
  if (tk.type === 'keyword' && !st.objectKey[k] && !st.afterDot[k]) {
    if (CLAUSE_KEYWORDS.has(tk.text)) return 'clause'
    if (tk.text === 'def' && k > 0) return 'def'
    // and/or 是关键字形态的双目运算符，与运算符形态一视同仁
    if (tk.text === 'and' || tk.text === 'or') return 'binop'
  }
  return null
}

/**
 * tokens[k] 之后是断点（k 是触发 token）的种类；null = 不是。
 * 对象键关键字仍是 afterClause ——「then: 之后换行」在 predict 与
 * decide 两侧都不加对象键守卫（见上方不对称清单之外的既有行为）。
 * 点号字段名（'.catch'、'$if_.elif'）在两侧都被排除 —— 字段访问
 * 是普通操作数，其后的换行照常折叠。
 */
export function breakAfter(st: TokenStream, k: number): BreakKind | null {
  const tk = st.tokens[k]
  if (tk.type === 'operator') {
    if (tk.text === ',' || tk.text === ';') return 'afterSep'
    if (tk.text === ':') return 'afterColon'
    if (OPENERS.has(tk.text)) return 'afterOpener'
    if (tk.text === '|' || isLineBreakBinop(tk)) return 'afterBinop'
    return null
  }
  if (tk.type === 'keyword' && !st.afterDot[k]) {
    if (CLAUSE_KEYWORDS.has(tk.text)) return 'afterClause'
    // try 的 body 与子句分支同形：另起一行，比 try 所在层深一层
    //（catch 与 try 对齐的既有规则不动）
    if (tk.text === 'try' && !st.objectKey[k]) return 'afterClause'
    if (tk.text === 'as' && !st.objectKey[k]) return 'afterAs'
    if ((tk.text === 'and' || tk.text === 'or') && !st.objectKey[k]) return 'afterBinop'
  }
  return null
}
