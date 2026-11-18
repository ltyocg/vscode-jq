/**
 * 源码断行推断（predict）：按源码形态推断「组会不会真的断行」「元素
 * 内部会不会断行」，并据此给出括号组的布局风格（悬挂式/分隔式、前导
 * 分隔符）。这是对反事实的推测 —— 回答「假如这样排，源码的换行会
 * 落在哪里」；真正决定断行的是 layout.ts 的 decide 引擎，两侧共用的
 * 断点词汇表见 breakkind.ts（含有意不对称的契约说明）。
 */
import { breakAfter, breakBefore } from './breakkind'
import type { FormatOptions } from './api'
import { Measure } from './measure'
import { CLOSERS, OPENERS } from './spacing'
import { MAX_SEGMENT_LOOKAHEAD, TokenStream, endLine, newlinesBetween } from './tokens'

/** 括号组的布局风格（layout.ts 的 GroupCtx 由此派生记账字段） */
export interface GroupStyle {
  /** 是否展开为多行（允许组内断行） */
  expanded: boolean
  /** 悬挂式：开括号后接了内容；非悬挂的展开组为分隔式 */
  hanging: boolean
  /** 组内顶层分隔符是否采用前导风格（源码在某个 ','/';' 之前换行） */
  leadSep: boolean
}

export class Predict {
  readonly #st: TokenStream
  readonly #opts: FormatOptions
  readonly #m: Measure
  /** 当前发射列数 —— 悬挂式判定的宽度预算随发射进度变化 */
  readonly #col: () => number

  constructor(st: TokenStream, opts: FormatOptions, m: Measure, col: () => number) {
    this.#st = st
    this.#opts = opts
    this.#m = m
    this.#col = col
  }

  /**
   * tokens[i] 的开括号组布局。是否展开与原先一致：源码组内有换行、
   * 含注释，或平铺后放不进本行。展开的组再分两种风格：
   *   - 悬挂式：源码里开括号后接了内容（且首个元素放得进开括号行），
   *     不强制断行，组内换行按源码保留，超宽才在分隔符处补断；
   *   - 分隔式：开括号、每个元素、闭括号各占一行。
   * leadSep 标记组内是否用了前导分隔符风格（见 GroupCtx）。
   */
  groupStyle(i: number): GroupStyle {
    const close = this.#st.match.get(i)!
    const leadSep = this.hasLeadingSeparator(i, close)
    if (close === i + 1) return { expanded: false, hanging: false, leadSep } // 空组
    let prevEnd = endLine(this.#st.tokens[i])
    let sourceBreak = false
    let hasComment = false
    for (let k = i + 1; k < close; k++) {
      const tk = this.#st.tokens[k]
      if (tk.line > prevEnd) sourceBreak = true
      if (tk.type === 'comment') hasComment = true
      prevEnd = endLine(tk)
    }
    if (this.#st.tokens[close].line > prevEnd) sourceBreak = true
    if (!sourceBreak && !hasComment) {
      // 源码单行：放得下就单行，放不下走分隔式
      const flat = this.#m.flatSpan(i + 1, close, this.#st.tokens[i].text)
      if (flat === null) return { expanded: true, hanging: false, leadSep }
      // 单行组不补内侧空格（各种括号一致），extra 只是闭括号
      const extra = 1
      return {
        expanded: this.#col() + flat.length + extra > this.#opts.printWidth,
        hanging: false,
        leadSep
      }
    }
    // 源码多行或含注释。但组内未必真的会断行：换行可能全落在会折叠
    // 的位置（表达式中间、前导逗号之前……）。会断行的才展开。
    if (!this.groupBreaks(i, close)) {
      // 意图是单行：放得下就按单行处理
      const flat = this.#m.flatSpan(i + 1, close, this.#st.tokens[i].text)
      // 此分支内不会有注释，flat 不会为 null；单行不补内侧空格
      const extra = 1
      if (flat !== null && this.#col() + flat.length + extra <= this.#opts.printWidth) {
        return { expanded: false, hanging: false, leadSep }
      }
    }
    // 展开且会断行：首个内容在开括号行、且首个元素放得进该行，
    // 用悬挂式；否则分隔式。开括号行上的行尾注释不参与宽度测量
    if (!this.firstOnOpenerLine(i, close)) return { expanded: true, hanging: false, leadSep }
    const flat = this.#m.flatSpan(
      i + 1,
      this.firstSeparator(i, close),
      this.#st.tokens[i].text,
      true
    )
    if (flat === null) return { expanded: true, hanging: false, leadSep }
    // +2：开括号后的补位空格 + 其后的分隔符（或闭括号）
    if (this.#col() + flat.length + 2 > this.#opts.printWidth) {
      return { expanded: true, hanging: false, leadSep }
    }
    return { expanded: true, hanging: true, leadSep }
  }

  /** 组内顶层 ','/';' 之前是否有源码换行（前导分隔符风格） */
  hasLeadingSeparator(i: number, close: number): boolean {
    let depth = 0
    for (let k = i + 1; k < close; k++) {
      const tk = this.#st.tokens[k]
      if (tk.type === 'operator' && OPENERS.has(tk.text)) depth++
      else if (tk.type === 'operator' && CLOSERS.has(tk.text)) depth--
      else if (depth === 0 && (tk.text === ',' || tk.text === ';')) {
        const prev = this.#st.tokens[k - 1]
        if (newlinesBetween(prev, tk) > 0) return true
      }
    }
    return false
  }

  /**
   * 组内是否会实际断行（按源码推断，忽略超宽补断）：合法断点处有
   * 换行、有注释、或有不处于行首的 def。嵌套组递归处理 —— 嵌套组
   * 若同样不会断行则渲染为单行，不算外层的断行。调用方只在整组
   * 平铺放得下时据此判单行，那时超宽断行不会触发，推断是精确的。
   */
  groupBreaks(i: number, close: number): boolean {
    for (let k = i + 1; k < close; k++) {
      const tk = this.#st.tokens[k]
      if (tk.type === 'comment') return true
      if (tk.type === 'operator' && OPENERS.has(tk.text)) {
        const innerClose = this.#st.match.get(k)!
        if (this.groupBreaks(k, innerClose)) return true
        k = innerClose // 跳过整个嵌套组
        continue
      }
      const prev = this.#st.tokens[k - 1]
      // 展开组内的 def 总会断行；紧跟开括号且同行的除外（悬挂式例外）。
      // 与源码换行无关：decideBreak 对展开组内的 def 总是断行，若只在
      // 未换行的分支计入，源码恰好在 def 之前换行的组会被误判成单行，
      // def 被折叠进行中。
      if (breakBefore(this.#st, k) === 'def' && k > i + 1) {
        return true
      }
      if (newlinesBetween(prev, tk) <= 0) {
        continue
      }
      // 源码此处有换行：只有落在合法断点处才会真的断行
      if (k === i + 1) return true // 开括号后首内容换行：展开必断
      // 行首管道/双目运算符/前导分隔符/子句关键字/reduce 分组开括号
      //（见 decideBreak）
      const bk = breakBefore(this.#st, k)
      if (bk === 'pipe' || bk === 'binop' || bk === 'leadSep' || bk === 'clause' || bk === 'reduce')
        return true
      // 分隔符、子句关键字或尾随双目运算符/管道之后的换行：元素/分支/
      // 操作数另起一行（见 decideBreak）
      const ak = breakAfter(this.#st, k - 1)
      if (ak === 'afterSep' || ak === 'afterClause' || ak === 'afterBinop') return true
    }
    const last = this.#st.tokens[close - 1]
    return this.#st.tokens[close].line > endLine(last)
  }

  /**
   * 组内首个 token（注释也算）是否与开括号同行 —— 行尾注释同样是
   * “开括号后接了内容”，组按悬挂式处理（注释自己会结束这一行，
   * 首个元素从下一行开始）。
   */
  firstOnOpenerLine(i: number, close: number): boolean {
    return close > i + 1 && this.#st.tokens[i + 1].line === this.#st.tokens[i].line
  }

  /**
   * 开括号行（悬挂式判定的宽度预算）的首个实际断点下标；没有则为
   * 闭括号下标。深度 0 的潜在断点候选与 decideBreak 一致（前导分隔
   * 符、行首管道/双目运算符、子句关键字；reduce 的 '(' 与尾随双目
   * 运算符/管道只在源码确有换行处终结预算）。嵌套组若自身会断行，
   * 预算延伸进它的首行：悬挂式递归取其首个断点，分隔式在开括号后
   * 即断；不会断行的嵌套组渲染为单行、整个跳过。单键对象这类「首个
   * 断点落在嵌套组内部」的组，若不递归就会按整组平铺量宽，被误判
   * 成分隔式、把键挤到单独一行。
   */
  firstSeparator(i: number, close: number): number {
    for (let k = i + 1; k < close; k++) {
      const tk = this.#st.tokens[k]
      if (tk.type === 'operator' && OPENERS.has(tk.text)) {
        const innerClose = this.#st.match.get(k)!
        const style = this.groupStyle(k)
        if (!style.expanded) {
          k = innerClose // 不会断行的嵌套组：渲染为单行，跳过
          continue
        }
        // 会断行的嵌套组：开括号行延伸进它的首行
        return style.hanging ? this.firstSeparator(k, innerClose) : k + 1
      }
      const bk = breakBefore(this.#st, k)
      if (bk === 'leadSep' || bk === 'pipe' || bk === 'binop' || bk === 'clause') return k
      if (
        (bk === 'reduce' && newlinesBetween(this.#st.tokens[k - 1], tk) > 0) ||
        (breakAfter(this.#st, k - 1) === 'afterBinop' &&
          newlinesBetween(this.#st.tokens[k - 1], tk) > 0)
      )
        return k
    }
    return close
  }

  /**
   * 悬挂组内从 tokens[j] 起的当前元素内部是否会断行（按源码推断）。
   * 元素到同层的下一个分隔符或闭括号为止；嵌套组递归用 groupBreaks
   * 判断（不会断行的组渲染为单行，整组跳过）。判断与 decideBreak
   * 的断点保持一致：行首管道/双目运算符/子句关键字、对象键冒号后的
   * 换行、注释。
   */
  elementBreaks(j: number): boolean {
    const cap = Math.min(this.#st.tokens.length, j + MAX_SEGMENT_LOOKAHEAD)
    for (let k = j; k < cap; k++) {
      const tk = this.#st.tokens[k]
      if (k > j) {
        if (tk.type === 'comment') return true
        // 元素边界：同层分隔符或闭括号
        if (
          tk.type === 'operator' &&
          (tk.text === ',' || tk.text === ';' || CLOSERS.has(tk.text))
        ) {
          return false
        }
        const prev = this.#st.tokens[k - 1]
        if (newlinesBetween(prev, tk) <= 0) continue
        // 源码此处有换行：落在合法断点上才会真的断行
        const bk = breakBefore(this.#st, k)
        if (bk === 'pipe' || bk === 'binop' || bk === 'clause' || bk === 'reduce') return true
        const ak = breakAfter(this.#st, k - 1)
        // 冒号之后换行：值另起一行。predict 侧不区分冒号种类（对象键/
        // def 头/切片），一律算断 —— decide 侧的细分见 decideBreak
        if (ak === 'afterColon') return true
        // 子句关键字之后换行：分支内容另起一行（见 decideBreak）
        if (ak === 'afterClause') return true
        // 尾随双目运算符/管道之后换行：操作数另起一行（见 decideBreak）
        if (ak === 'afterBinop') return true
      } else if (tk.type === 'operator' && (tk.text === ',' || tk.text === ';')) {
        return false // 空元素（j 本身就是分隔符）
      }
      if (tk.type === 'operator' && OPENERS.has(tk.text)) {
        // 嵌套组：组内会断行则元素内部断行；否则整组跳过（渲染为单行）
        const innerClose = this.#st.match.get(k)!
        if (this.groupBreaks(k, innerClose)) return true
        k = innerClose // 跳过整个嵌套组
      }
    }
    return false
  }
}
