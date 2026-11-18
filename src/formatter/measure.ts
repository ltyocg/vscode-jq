/**
 * 行宽测量：把片段试排成一行并量宽度、找片段边界。纯推测 —— 只读
 * token 流与发射进度（col 回调），不触碰任何发射状态。
 *
 * flatSpan / segmentWidth 在每次断行决策时各被调用常数次，每次为
 * 片段长度的线性开销；findSegmentEnd 以 MAX_SEGMENT_LOOKAHEAD 封顶，
 * 整体不会超出单遍扫描的常数倍。
 */
import { breakBefore } from './breakkind'
import type { FormatOptions } from './api'
import { CLOSERS, OPENERS, gapBetween, padsInsideBracket, type BracketStyle, type FmtToken } from './spacing'
import { MAX_SEGMENT_LOOKAHEAD, TokenStream, endLine, newlinesBetween } from './tokens'

/**
 * flatSpan 的补位风格：跨距内的组一律按单行模拟（见 spacing.ts 的
 * padsInsideBracket，单行组不补位）。stack 是跨距内已开未闭的括号
 * 种类栈，空栈表示当前不在任何组内。
 */
function flatStyle(stack: string[]): BracketStyle | null {
  return stack.length ? { expanded: false, hanging: false } : null
}

export class Measure {
  readonly #st: TokenStream
  readonly #opts: FormatOptions
  /** 当前发射列数 —— 测量是活的，随发射进度变化 */
  readonly #col: () => number

  constructor(st: TokenStream, opts: FormatOptions, col: () => number) {
    this.#st = st
    this.#opts = opts
    this.#col = col
  }

  /**
   * 把 tokens[start, end) 试排成一行；片段含注释时返回 null。
   * ignoreComments 为真时跳过注释而不是放弃测量 —— 用于悬挂式判定：
   * 开括号行上的行尾注释不参与代码宽度（注释本身不受行宽约束），
   * 不应把组挤成分隔式。
   */
  flatSpan(start: number, end: number, hint: string, ignoreComments = false): string | null {
    let out = ''
    // 跨距内已开未闭的组的括号种类
    const stack: string[] = []
    let prev: FmtToken | undefined
    for (let k = start; k < end; k++) {
      const tk = this.#st.tokens[k]
      if (tk.type === 'comment') {
        if (!ignoreComments) return null
        continue
      }
      const enclosing = stack.length ? stack[stack.length - 1] : hint
      if (prev) {
        if (gapBetween(prev, tk, enclosing) === 'space') out += ' '
        else if (padsInsideBracket(prev, tk, flatStyle(stack))) out += ' '
      }
      out += tk.text
      if (tk.type === 'operator' && OPENERS.has(tk.text)) stack.push(tk.text)
      else if (tk.type === 'operator' && CLOSERS.has(tk.text)) stack.pop()
      prev = tk
    }
    return out
  }

  /** 从 j 起第一个合法断点（不含 j 自身）的下标。 */
  findSegmentEnd(j: number): number {
    let depth = 0
    const cap = Math.min(this.#st.tokens.length, j + MAX_SEGMENT_LOOKAHEAD)
    for (let k = j; k < cap; k++) {
      const tk = this.#st.tokens[k]
      if (k > j) {
        if (tk.type === 'comment') return k // 注释永远终结它所在的一行
        // 深度 0 的任意断点种类都终结片段（词汇表的全集）。reduce 的
        // '(' 除外：它无超宽补断，仅源码确有换行时才真的断行，未换行
        // 时片段要跨过 reduce 分组继续量宽
        if (depth === 0) {
          const bk = breakBefore(this.#st, k)
          if (bk !== null && (bk !== 'reduce' || newlinesBetween(this.#st.tokens[k - 1], tk) > 0))
            return k
        }
      }
      if (tk.type === 'operator' && OPENERS.has(tk.text)) depth++
      else if (tk.type === 'operator' && CLOSERS.has(tk.text)) depth--
    }
    return this.#st.tokens.length
  }

  /** 从 j 起下一个片段的单行宽度；含注释（不可平铺）时为无穷。 */
  segmentWidth(j: number): number {
    // 前置的行尾注释贴在当前行上，不计入其后片段的宽度
    let start = j
    while (start < this.#st.tokens.length && this.#st.tokens[start].type === 'comment') start++
    const flat = this.flatSpan(start, this.findSegmentEnd(start), '')
    return flat === null ? Infinity : flat.length
  }

  /** '|' 之后的片段是否会超出行宽（3 是 ' | ' 的宽度）。 */
  pipeOverflow(i: number): boolean {
    const seg = this.segmentWidth(i + 1)
    return seg === Infinity || this.#col() + 3 + seg > this.#opts.printWidth
  }

  /** 双目运算符续在本行是否会超宽（运算符两侧各一个空格 + 其后片段）。 */
  operatorOverflow(i: number): boolean {
    const seg = this.segmentWidth(i + 1)
    return (
      seg === Infinity ||
      this.#col() + this.#st.tokens[i].text.length + 2 + seg > this.#opts.printWidth
    )
  }

  /**
   * 子句关键字之后的片段是否会超出行宽。源码里关键字后（跳过注释）
   * 就是换行的，关键字行到此为止，不可能超宽 —— 分支内容按源码留在
   * 后续行，不把关键字挤到单独一行。
   */
  clauseOverflow(i: number): boolean {
    const t = this.#st.tokens[i]
    if (t.text !== 'then' && t.text !== 'elif' && t.text !== 'else') return false
    const next = this.#st.tokens[i + 1]
    if (next === undefined || next.type === 'comment') return false
    if (next.line > endLine(t)) return false
    const seg = this.segmentWidth(i + 1)
    return seg === Infinity || this.#col() + t.text.length + 1 + seg > this.#opts.printWidth
  }

  /** 悬挂组内：当前元素续在本行是否会超宽（1 是元素前的一个空格） */
  elementOverflow(i: number): boolean {
    const seg = this.segmentWidth(i)
    return seg === Infinity || this.#col() + 1 + seg > this.#opts.printWidth
  }
}
