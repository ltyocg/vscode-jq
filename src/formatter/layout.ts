/**
 * 布局层：单遍扫描 token 流，决定断行、缩进与括号组展开。
 *
 * Layout 类持有全部语法上下文（括号组栈、子句栈、def 记账），
 * 行发射委托给 LineBuilder,token 间距规则来自 spacing.ts,
 * token 流的派生信息（括号配对、对象键判定、位置算术）来自
 * tokens.ts。
 */

import type { FormatOptions } from './api'
import { LineBuilder, trimLineEnd } from './emit'
import { CLAUSE_KEYWORDS, CLOSERS, LINE_BREAK_BINOPS, OPENERS, gapBetween, type FmtToken } from './spacing'
import {
  MAX_SEGMENT_LOOKAHEAD,
  TokenStream,
  endCol,
  endLine,
  newlinesBetween
} from './tokens'

/**
 * 保留的连续空行上限：源码空行原样保留、绝不凭空增加，
 * 连续两个以上的空行压缩到两个。
 */
const MAX_BLANK_LINES = 2

/** 括号组('(' / '[' / '{')的布局上下文 */
interface GroupCtx {
  kind: '(' | '[' | '{'
  /** 是否展开为多行（允许组内断行） */
  expanded: boolean
  /**
   * 悬挂式：源码里开括号后接了内容。组内只在源码换行处（或超宽时）
   * 断行，源码未换行的闭括号留在行内。非悬挂的展开组为分隔式：
   * 开括号、每个元素、闭括号各占一行。
   */
  hanging: boolean
  /** 组关闭时要恢复的 ctxIndent（列数） */
  savedIndent: number
  /**
   * 开括号所在行的缩进列数。分隔式展开组的闭括号回到这一列 ——
   * 管道断行后该行比 ctxIndent 深一层，组内容与闭括号必须跟着
   * 它，而不是管道前的上下文。
   */
  closeIndent: number
  /**
   * 开括号自身的列数（可能处在行中间，如 '+ {' 的 '{'）。悬挂式组的
   * 前导分隔符对齐到这一列，与开括号同列。
   */
  alignCol: number
  /**
   * 组内顶层分隔符是否采用前导风格（源码在某个 ','/';' 之前换行）。
   * 前导风格的悬挂组闭括号也回到开括号所在列；普通悬挂组的闭括号
   * 回到开括号所在行的行首（与行首双目运算符的层级一致）。
   */
  leadSep: boolean
}

/** if/try 子句的布局上下文 */
interface ClauseCtx {
  kind: 'if' | 'try'
  /** 'if'/'try' 所在行的缩进列数 */
  indent: number
}

/**
 * def 语句的记账：把"头部待定、冒号归属、函数体缩进"三件事收在
 * 一个对象里，代替原先散装的三四个标志位。
 */
interface DefCtx {
  /**
   * 正在等待头部 ':' 的 def 所在的括号深度；'def' 后面必须紧跟
   * IDENT 和 ':'/'(' 才算真正的定义（排除 `{def: 1}` 这类对象键），
   * 否则为 null。
   */
  pendingDepth: number | null
  /** 最近一个 ':' 是否属于 def 头部（其后允许断行） */
  lastColonWasDef: boolean
  /** 已进入函数体的 def：记录进入时的缩进（列数），遇到配对的 ';' 时恢复 */
  stack: { depth: number; savedIndent: number }[]
}

/** 断行决策：indent 为新行的缩进列数，null 表示不断行 */
interface BreakDecision {
  indent: number | null
}

export class Layout {
  // -- 语法上下文 --
  private readonly groups: GroupCtx[] = []
  private readonly clauses: ClauseCtx[] = []
  private readonly def: DefCtx = { pendingDepth: null, lastColonWasDef: false, stack: [] }

  // -- 游标状态 --
  /** 当前上下文中新行的缩进列数 */
  private ctxIndent = 0
  /** 行尾注释吃掉本行后留下的强制断行 */
  private pendingForcedBreak = false
  /**
   * 正在 if/try 子句的分支里：分支内容的缩进，以及进入分支时的括号
   * 深度（深度变化说明注释/内容已进入更深的括号组，不再用分支缩进）。
   * 分支里的独立注释与分支内容对齐到同一缩进。
   */
  private bodyIndent: { indent: number; depth: number } | null = null
  private prevReal: FmtToken | undefined
  /** 上一个已发射内容（代码 token 或注释）的结束行号 */
  private lastAnyEndLine = -1

  constructor(
    private readonly st: TokenStream,
    private readonly opts: FormatOptions,
    private readonly out: LineBuilder
  ) {
    // 便捷别名：token 与括号配对是最高频的访问
    this.tokens = st.tokens
    this.match = st.match
  }

  private readonly tokens: readonly FmtToken[]
  private readonly match: ReadonlyMap<number, number>

  run(): void {
    for (let i = 0; i < this.tokens.length; i++) {
      const t = this.tokens[i]

      if (t.type === 'comment') {
        this.emitComment(t)
        continue
      }

      // 距上一个已发射内容（代码 token 或注释）的换行数。统一用
      // lastAnyEndLine 度量：若跨过独立注释测到上一个代码 token,
      // 注释自身占的行会被误计成空行。
      const nl = this.lastAnyEndLine >= 0 ? t.line - this.lastAnyEndLine : 0
      // 源码空行原样保留（封顶 MAX_BLANK_LINES 个），绝不凭空增加
      const blanks = this.blankCount(t.line)
      const forced = this.pendingForcedBreak
      this.pendingForcedBreak = false

      const d = this.decideBreak(i, nl, forced)

      // -- 发射 --
      if (d.indent !== null) {
        if (this.out.hasContent) this.out.finishLine()
        this.emitBlanks(blanks)
        this.out.startLine(d.indent)
        this.out.append(t.text, false)
      } else {
        // 独立注释之后另起的内容行：源码空行同样保留
        if (!this.out.hasContent) this.emitBlanks(blanks)
        const space = this.prevReal
          ? gapBetween(this.prevReal, t, this.enclosingKind) === 'space' ||
            this.bracketPadding(this.prevReal, t)
          : false
        this.out.append(t.text, space)
      }

      // -- 记账：语法上下文与游标 --
      this.updateContexts(t, i)
      this.prevReal = t
      this.lastAnyEndLine = endLine(t)
    }
    if (this.out.hasContent) this.out.finishLine()
  }

  /** line 与上一内容之间的源码空行数，封顶 MAX_BLANK_LINES */
  private blankCount(line: number): number {
    if (this.lastAnyEndLine < 0) return 0
    return Math.min(Math.max(line - this.lastAnyEndLine - 1, 0), MAX_BLANK_LINES)
  }

  /** 输出 n 个空行；不紧跟在空行或文件头之后 */
  private emitBlanks(n: number): void {
    if (n <= 0) return
    const last = this.out.lastLine()
    if (last !== undefined && last !== '') this.out.addBlankLines(n)
  }

  /** 内层开括号字符（'(' / '[' / '{'），语句级为 '' */
  private get enclosingKind(): string {
    const g = this.groups[this.groups.length - 1]
    return g ? g.kind : ''
  }

  /**
   * 括号内侧补一个空格（空组除外）：
   *  - 单行组：只有对象大括号补；
   *  - 悬挂式展开组（开括号后接内容）：各种括号都补，开括号之后、
   *    与内容同行的闭括号之前各恰好一个。
   * 补空格只在 token 续在本行时生效（LineBuilder.append 在行首不加
   * 空格），断行处自然没有空格，分隔式展开组因此不受影响。
   */
  private bracketPadding(prev: FmtToken, t: FmtToken): boolean {
    const g = this.groups[this.groups.length - 1]
    if (!g || !(g.hanging || (!g.expanded && g.kind === '{'))) return false
    const prevIsOpener = prev.type === 'operator' && OPENERS.has(prev.text)
    const tIsCloser = t.type === 'operator' && CLOSERS.has(t.text)
    if (prevIsOpener && tIsCloser) return false // 空组 '{}'
    return prevIsOpener || tIsCloser
  }

  private emitComment(t: FmtToken): void {
    const text = trimLineEnd(t.text)
    if (t.line === this.lastAnyEndLine && this.lastAnyEndLine >= 0) {
      // 行尾注释：留在当前行，并吃掉这一行剩下的部分。
      // 与前面代码的间距按源码原样保留，不足一个空格则补一个。
      const gap = this.prevReal ? t.col - endCol(this.prevReal) : 1
      this.out.appendTrailingComment(text, Math.max(gap, 1))
      this.pendingForcedBreak = true
    } else {
      // 独立注释：独占一行，缩进与当前上下文一致；正处某个子句分支
      // 里（且未进入更深的括号组）时，对齐到分支内容的缩进。
      // 与上一个输出之间的源码空行原样保留。先结束未完的当前行，
      // 空行才能落在它和注释之间。
      if (this.out.hasContent) this.out.finishLine()
      this.emitBlanks(this.blankCount(t.line))
      const indent =
        this.bodyIndent !== null && this.bodyIndent.depth === this.groups.length
          ? this.bodyIndent.indent
          : this.ctxIndent
      this.out.addStandaloneLine(indent, text)
    }
    // 续行注释（行尾奇数个反斜杠）本身横跨多行
    this.lastAnyEndLine = endLine(t)
  }

  /**
   * 断行决策（先命中先生效）：
   *   1. 当前 token 自身（'|'、闭括号、子句关键字、def）；
   *   2. 前一个代码 token 之后（';'/','/':'/开括号）；
   *   3. 行尾注释留下的强制断行。
   */
  private decideBreak(i: number, nl: number, forced: boolean): BreakDecision {
    const t = this.tokens[i]
    const innerGroup = this.groups[this.groups.length - 1]
    const inlineInnermost = this.groups.length > 0 && !innerGroup.expanded
    // `{if: 1}` —— 关键字作为对象键，不是子句/def 关键字
    const objectKey = this.st.objectKey[i]

    let indent: number | null = null

    if (t.type === 'operator') {
      if (t.text === '|') {
        // 管道：源码此处有换行，或下一片段放不进本行，则以行首 '|'
        // 断行（比上下文深一层）
        if (!inlineInnermost && (nl > 0 || this.pipeOverflow(i))) {
          indent = this.ctxIndent + this.opts.indentSize
        }
      } else if (CLOSERS.has(t.text)) {
        // 展开组的闭括号：前导分隔符风格的悬挂组回到开括号所在列，
        // 其余悬挂组与分隔式回到开括号所在行的行首；悬挂式且源码闭括号
        // 未换行时，留在最后一个元素所在的行内
        if (innerGroup && innerGroup.expanded && !(innerGroup.hanging && nl === 0)) {
          indent =
            innerGroup.hanging && innerGroup.leadSep ? innerGroup.alignCol : innerGroup.closeIndent
        }
      } else if (this.isBinop(t) && !inlineInnermost && (nl > 0 || this.operatorOverflow(i))) {
        // 双目运算符：源码此处有换行，或其后的片段放不进本行，则以
        // 行首运算符断行，与本行（表达式起始行）同层
        indent = this.out.indentCols
      } else if (
        (t.text === ',' || t.text === ';') &&
        innerGroup !== undefined &&
        innerGroup.expanded &&
        innerGroup.hanging &&
        nl > 0
      ) {
        // 前导分隔符：悬挂组里源码在 ','/';' 之前换行时，分隔符提到
        // 行首，与开括号同列对齐（与前导双目运算符同一种风格，
        // jq 源码里常见）
        indent = innerGroup.alignCol
      }
    } else if (t.type === 'keyword' && !objectKey) {
      if (CLAUSE_KEYWORDS.has(t.text)) {
        // 子句关键字：源码有换行或行宽不够时，回到 if/try 所在行的行首
        if (!inlineInnermost && (nl > 0 || this.clauseOverflow(i))) {
          indent = this.findClauseIndent(t.text === 'catch' ? 'try' : 'if') ?? this.ctxIndent
        }
      } else if (t.text === 'def' && i > 0) {
        // def 总是从新行开始（空行保留与断行原因无关，统一按源码处理）；
        // 例外：悬挂式开括号行上的 def（否则悬挂排列被破坏，反复格式化
        // 结果不稳定），以及未展开组内的 def（组保持单行）
        const p = this.prevReal
        const afterHangingOpener =
          !!p &&
          p.type === 'operator' &&
          OPENERS.has(p.text) &&
          (this.groups[this.groups.length - 1]?.hanging ?? false)
        if (!afterHangingOpener && !inlineInnermost) indent = this.ctxIndent
      }
    }

    if (indent === null && this.prevReal) {
      const p = this.prevReal
      if (p.type === 'operator') {
        if (p.text === ';') {
          // def 结束的 ';'：语句级回到 ctxIndent；组内按组风格断行
          if (this.groups.length === 0) {
            indent = this.ctxIndent
          } else if (this.separatorBreaks(nl, i)) {
            indent = this.ctxIndent
          }
        } else if (p.text === ',') {
          // 逗号：语句级保留源码换行；组内按组风格断行
          if (this.groups.length === 0) {
            if (nl > 0) indent = this.ctxIndent
          } else if (this.separatorBreaks(nl, i)) {
            indent = this.ctxIndent
          }
        } else if (p.text === ':') {
          if (this.def.lastColonWasDef) {
            // def 头部的 ':' 之后：所有括号组都展开时才允许换行
            if (nl > 0 && this.groups.every((g) => g.expanded)) indent = this.ctxIndent
          } else if (
            this.enclosingKind === '{' &&
            innerGroup !== undefined &&
            innerGroup.expanded &&
            nl > 0
          ) {
            // 对象键的冒号之后：源码换行处保留，值比键所在行深一层
            indent = this.out.indentCols + this.opts.indentSize
          }
        } else if (OPENERS.has(p.text)) {
          // 分隔式展开组的开括号之后：第一个元素另起一行（悬挂式不断）
          const g = this.groups[this.groups.length - 1]
          if (g?.expanded && !g.hanging) indent = this.ctxIndent
        }
      } else if (
        p.type === 'keyword' &&
        (p.text === 'then' || p.text === 'elif' || p.text === 'else' || p.text === 'catch')
      ) {
        // 子句关键字之后源码换行：分支内容另起一行，缩进取分支缩进
        //（与子句关键字同层，但不浅于所在括号组的内容层）；elif 后是
        // 条件而非分支，回到上下文缩进
        if (nl > 0) indent = this.bodyIndent?.indent ?? this.ctxIndent
      }
    }

    if (indent === null && forced) {
      // 注释尾随在 '|' 之后时，管道继续以 pipe 层断行
      indent =
        this.prevReal && this.prevReal.type === 'operator' && this.prevReal.text === '|'
          ? this.ctxIndent + this.opts.indentSize
          : this.ctxIndent
    }

    return { indent }
  }

  /**
   * 发射 token 之后的语法记账：括号组进出、def 头部/函数体缩进、
   * if/try 子句栈。
   */
  private updateContexts(t: FmtToken, i: number): void {
    // `{if: 1}` —— 关键字作为对象键，不触发任何语法记账
    const objectKey = this.st.objectKey[i]

    if (t.type === 'operator') {
      if (OPENERS.has(t.text)) {
        const style = this.groupStyle(i)
        this.groups.push({
          kind: t.text as '(' | '[' | '{',
          expanded: style.expanded,
          hanging: style.hanging,
          savedIndent: this.ctxIndent,
          closeIndent: this.out.indentCols,
          // 开括号刚发射完毕：其起始列 = 当前行末列减去自身宽度
          alignCol: this.out.col() - t.text.length,
          leadSep: style.leadSep
        })
        if (style.expanded) {
          this.ctxIndent = this.out.indentCols + this.opts.indentSize
          // 分隔式：开括号后第一个元素另起一行；悬挂式不断
          if (!style.hanging) this.pendingForcedBreak = true
        }
      } else if (CLOSERS.has(t.text)) {
        const g = this.groups.pop()
        if (g) this.ctxIndent = g.savedIndent
      } else if (t.text === ':') {
        if (this.def.pendingDepth !== null && this.groups.length === this.def.pendingDepth) {
          // def 头部的 ':'：进入函数体，缩进一层，遇到配对的 ';' 恢复
          this.def.stack.push({ depth: this.def.pendingDepth, savedIndent: this.ctxIndent })
          this.ctxIndent += this.opts.indentSize
          this.def.lastColonWasDef = true
          this.def.pendingDepth = null
        } else {
          this.def.lastColonWasDef = false
        }
      } else if (t.text === ';') {
        const top = this.def.stack[this.def.stack.length - 1]
        if (top && top.depth === this.groups.length)
          this.ctxIndent = this.def.stack.pop()!.savedIndent
      }
    } else if (t.type === 'keyword' && !objectKey) {
      if (t.text === 'def') {
        // 只有真正的定义：'def' IDENT (':' | '(' …)
        const n1 = this.tokens[i + 1]
        const n2 = this.tokens[i + 2]
        this.def.pendingDepth =
          !!n1 &&
          n1.type === 'ident' &&
          !!n2 &&
          n2.type === 'operator' &&
          (n2.text === ':' || n2.text === '(')
            ? this.groups.length
            : null
      } else if (t.text === 'if') {
        this.clauses.push({ kind: 'if', indent: this.out.indentCols })
        this.bodyIndent = null
      } else if (t.text === 'try') {
        this.clauses.push({ kind: 'try', indent: this.out.indentCols })
        this.bodyIndent = null
      } else if (t.text === 'then' || t.text === 'else') {
        // 进入 if 分支：分支缩进 = 子句关键字所在层与上下文层的较大者
        const clause = this.findClauseIndent('if') ?? this.ctxIndent
        this.bodyIndent = { indent: Math.max(clause, this.ctxIndent), depth: this.groups.length }
      } else if (t.text === 'elif') {
        this.bodyIndent = null // elif 之后是条件，不是分支
      } else if (t.text === 'end') {
        this.popClause('if')
        this.bodyIndent = null
      } else if (t.text === 'catch') {
        const clause = this.findClauseIndent('try') ?? this.ctxIndent
        const indent = Math.max(clause, this.ctxIndent)
        this.popClause('try')
        this.bodyIndent = { indent, depth: this.groups.length }
      }
    }
  }

  // -- 行宽测量 -----------------------------------------------------------
  //
  // flatSpan / segmentWidth 在每次断行决策时各被调用常数次，每次为
  // 片段长度的线性开销；findSegmentEnd 以 MAX_SEGMENT_LOOKAHEAD 封顶，
  // 整体不会超出单遍扫描的常数倍。

  /**
   * 把 tokens[start, end) 试排成一行；片段含注释时返回 null。
   * ignoreComments 为真时跳过注释而不是放弃测量 —— 用于悬挂式判定：
   * 开括号行上的行尾注释不参与代码宽度（注释本身不受行宽约束），
   * 不应把组挤成分隔式。
   */
  private flatSpan(start: number, end: number, hint: string, ignoreComments = false): string | null {
    let out = ''
    // 跨距内已开未闭的组的括号种类
    const stack: string[] = []
    let prev: FmtToken | undefined
    for (let k = start; k < end; k++) {
      const tk = this.tokens[k]
      if (tk.type === 'comment') {
        if (!ignoreComments) return null
        continue
      }
      const enclosing = stack.length ? stack[stack.length - 1] : hint
      if (prev) {
        if (gapBetween(prev, tk, enclosing) === 'space') out += ' '
        else if (this.flatPad(prev, tk, stack)) out += ' '
      }
      out += tk.text
      if (tk.type === 'operator' && OPENERS.has(tk.text)) stack.push(tk.text)
      else if (tk.type === 'operator' && CLOSERS.has(tk.text)) stack.pop()
      prev = tk
    }
    return out
  }

  /**
   * flatSpan 按单行模拟，跨距内的组一律视为不换行：只有对象大括号组
   * 在开括号之后、闭括号之前各补一个空格（空组除外；闭括号还需配对
   * 开括号在跨距内）。与发射路径的 bracketPadding 保持一致，宽度
   * 测量才不漂移。
   */
  private flatPad(prev: FmtToken, tk: FmtToken, stack: string[]): boolean {
    const prevIsOpener = prev.type === 'operator' && OPENERS.has(prev.text)
    const tkIsCloser = tk.type === 'operator' && CLOSERS.has(tk.text)
    if (prevIsOpener && tkIsCloser) return false // 空组 '{}'
    if (prevIsOpener) return prev.text === '{'
    return tkIsCloser && stack.length > 0 && stack[stack.length - 1] === '{'
  }

  /** 从 j 起第一个合法断点（不含 j 自身）的下标。 */
  private findSegmentEnd(j: number): number {
    let depth = 0
    const cap = Math.min(this.tokens.length, j + MAX_SEGMENT_LOOKAHEAD)
    for (let k = j; k < cap; k++) {
      const tk = this.tokens[k]
      if (k > j) {
        if (tk.type === 'comment') return k // 注释永远终结它所在的一行
        if (depth === 0) {
          if (
            tk.type === 'operator' &&
            (tk.text === '|' || tk.text === ';' || tk.text === ',' || CLOSERS.has(tk.text))
          ) {
            return k
          }
          if (tk.type === 'operator' && this.isBinop(tk)) return k
          if (
            tk.type === 'keyword' &&
            (CLAUSE_KEYWORDS.has(tk.text) || tk.text === 'def') &&
            !this.st.objectKey[k]
          ) {
            return k
          }
        }
      }
      if (tk.type === 'operator' && OPENERS.has(tk.text)) depth++
      else if (tk.type === 'operator' && CLOSERS.has(tk.text)) depth--
    }
    return this.tokens.length
  }

  /** 从 j 起下一个片段的单行宽度；含注释（不可平铺）时为无穷。 */
  private segmentWidth(j: number): number {
    // 前置的行尾注释贴在当前行上，不计入其后片段的宽度
    let start = j
    while (start < this.tokens.length && this.tokens[start].type === 'comment') start++
    const flat = this.flatSpan(start, this.findSegmentEnd(start), '')
    return flat === null ? Infinity : flat.length
  }

  /** '|' 之后的片段是否会超出行宽（3 是 ' | ' 的宽度）。 */
  private pipeOverflow(i: number): boolean {
    const seg = this.segmentWidth(i + 1)
    return seg === Infinity || this.out.col() + 3 + seg > this.opts.printWidth
  }

  /** 可在行首断行的双目运算符（一元 '-' 除外） */
  private isBinop(t: FmtToken): boolean {
    return t.type === 'operator' && LINE_BREAK_BINOPS.has(t.text) && !(t.text === '-' && t.unary)
  }

  /** 双目运算符续在本行是否会超宽（运算符两侧各一个空格 + 其后片段）。 */
  private operatorOverflow(i: number): boolean {
    const seg = this.segmentWidth(i + 1)
    return (
      seg === Infinity ||
      this.out.col() + this.tokens[i].text.length + 2 + seg > this.opts.printWidth
    )
  }

  /**
   * 子句关键字之后的片段是否会超出行宽。源码里关键字后（跳过注释）
   * 就是换行的，关键字行到此为止，不可能超宽 —— 分支内容按源码留在
   * 后续行，不把关键字挤到单独一行。
   */
  private clauseOverflow(i: number): boolean {
    const t = this.tokens[i]
    if (t.text !== 'then' && t.text !== 'elif' && t.text !== 'else') return false
    const next = this.tokens[i + 1]
    if (next === undefined || next.type === 'comment') return false
    if (next.line > endLine(t)) return false
    const seg = this.segmentWidth(i + 1)
    return seg === Infinity || this.out.col() + t.text.length + 1 + seg > this.opts.printWidth
  }

  /**
   * tokens[i] 的开括号组布局。是否展开与原先一致：源码组内有换行、
   * 含注释，或平铺后放不进本行。展开的组再分两种风格：
   *   - 悬挂式：源码里开括号后接了内容（且首个元素放得进开括号行），
   *     不强制断行，组内换行按源码保留，超宽才在分隔符处补断；
   *   - 分隔式：开括号、每个元素、闭括号各占一行。
   * leadSep 标记组内是否用了前导分隔符风格（见 GroupCtx）。
   */
  private groupStyle(i: number): { expanded: boolean; hanging: boolean; leadSep: boolean } {
    const close = this.match.get(i)!
    const leadSep = this.hasLeadingSeparator(i, close)
    if (close === i + 1) return { expanded: false, hanging: false, leadSep } // 空组
    let prevEnd = endLine(this.tokens[i])
    let sourceBreak = false
    let hasComment = false
    for (let k = i + 1; k < close; k++) {
      const tk = this.tokens[k]
      if (tk.line > prevEnd) sourceBreak = true
      if (tk.type === 'comment') hasComment = true
      prevEnd = endLine(tk)
    }
    if (this.tokens[close].line > prevEnd) sourceBreak = true
    if (!sourceBreak && !hasComment) {
      // 源码单行：放得下就单行，放不下走分隔式
      const flat = this.flatSpan(i + 1, close, this.tokens[i].text)
      if (flat === null) return { expanded: true, hanging: false, leadSep }
      // 内侧补位空格（只有大括号组补）+ 闭括号
      const extra = this.tokens[i].text === '{' ? 3 : 1
      return {
        expanded: this.out.col() + flat.length + extra > this.opts.printWidth,
        hanging: false,
        leadSep
      }
    }
    // 源码多行或含注释。但组内未必真的会断行：换行可能全落在会折叠
    // 的位置（表达式中间、前导逗号之前……）。会断行的才展开。
    if (!this.groupBreaks(i, close)) {
      // 意图是单行：放得下就按单行处理（内侧补空格）
      const flat = this.flatSpan(i + 1, close, this.tokens[i].text)
      // 此分支内不会有注释，flat 不会为 null
      const extra = this.tokens[i].text === '{' ? 3 : 1
      if (flat !== null && this.out.col() + flat.length + extra <= this.opts.printWidth) {
        return { expanded: false, hanging: false, leadSep }
      }
    }
    // 展开且会断行：首个内容在开括号行、且首个元素放得进该行，
    // 用悬挂式；否则分隔式。开括号行上的行尾注释不参与宽度测量
    if (!this.firstOnOpenerLine(i, close)) return { expanded: true, hanging: false, leadSep }
    const flat = this.flatSpan(i + 1, this.firstSeparator(i, close), this.tokens[i].text, true)
    if (flat === null) return { expanded: true, hanging: false, leadSep }
    // +2：开括号后的补位空格 + 其后的分隔符（或闭括号）
    if (this.out.col() + flat.length + 2 > this.opts.printWidth) {
      return { expanded: true, hanging: false, leadSep }
    }
    return { expanded: true, hanging: true, leadSep }
  }

  /** 组内顶层 ','/';' 之前是否有源码换行（前导分隔符风格） */
  private hasLeadingSeparator(i: number, close: number): boolean {
    let depth = 0
    for (let k = i + 1; k < close; k++) {
      const tk = this.tokens[k]
      if (tk.type === 'operator' && OPENERS.has(tk.text)) depth++
      else if (tk.type === 'operator' && CLOSERS.has(tk.text)) depth--
      else if (depth === 0 && (tk.text === ',' || tk.text === ';')) {
        const prev = this.tokens[k - 1]
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
  private groupBreaks(i: number, close: number): boolean {
    for (let k = i + 1; k < close; k++) {
      const tk = this.tokens[k]
      if (tk.type === 'comment') return true
      if (tk.type === 'operator' && OPENERS.has(tk.text)) {
        const innerClose = this.match.get(k)!
        if (this.groupBreaks(k, innerClose)) return true
        k = innerClose // 跳过整个嵌套组
        continue
      }
      const prev = this.tokens[k - 1]
      // 展开组内的 def 总会断行；紧跟开括号且同行的除外（悬挂式例外）。
      // 与源码换行无关：decideBreak 对展开组内的 def 总是断行，若只在
      // 未换行的分支计入，源码恰好在 def 之前换行的组会被误判成单行，
      // def 被折叠进行中。
      if (
        tk.type === 'keyword' &&
        tk.text === 'def' &&
        !this.st.objectKey[k] &&
        k > i + 1
      ) {
        return true
      }
      const nl = newlinesBetween(prev, tk)
      if (nl <= 0) {
        continue
      }
      // 源码此处有换行：只有落在合法断点处才会真的断行
      if (k === i + 1) return true // 开括号后首内容换行：展开必断
      if (tk.type === 'operator' && tk.text === '|') return true
      if (tk.type === 'operator' && this.isBinop(tk)) return true
      // 前导分隔符：悬挂组里会以行首 ','/';' 断行（见 decideBreak）
      if (tk.type === 'operator' && (tk.text === ',' || tk.text === ';')) return true
      if (tk.type === 'keyword' && CLAUSE_KEYWORDS.has(tk.text) && !this.st.objectKey[k]) {
        return true
      }
      // 子句关键字之后的换行：分支内容另起一行（见 decideBreak）
      if (prev.type === 'keyword' && CLAUSE_KEYWORDS.has(prev.text)) return true
      if (prev.type === 'operator' && (prev.text === ',' || prev.text === ';')) return true
    }
    const last = this.tokens[close - 1]
    return this.tokens[close].line > endLine(last)
  }

  /**
   * 组内首个 token（注释也算）是否与开括号同行 —— 行尾注释同样是
   * “开括号后接了内容”，组按悬挂式处理（注释自己会结束这一行，
   * 首个元素从下一行开始）。
   */
  private firstOnOpenerLine(i: number, close: number): boolean {
    return close > i + 1 && this.tokens[i + 1].line === this.tokens[i].line
  }

  /**
   * 组内第一个顶层断点候选（','、';'、'|' 或子句关键字）的下标；
   * 没有则为闭括号下标。用于测量悬挂式开括号行的宽度。
   */
  private firstSeparator(i: number, close: number): number {
    let depth = 0
    for (let k = i + 1; k < close; k++) {
      const tk = this.tokens[k]
      if (tk.type === 'operator' && OPENERS.has(tk.text)) depth++
      else if (tk.type === 'operator' && CLOSERS.has(tk.text)) depth--
      else if (
        depth === 0 &&
        ((tk.type === 'operator' &&
          (tk.text === ',' || tk.text === ';' || tk.text === '|' || this.isBinop(tk))) ||
          (tk.type === 'keyword' && CLAUSE_KEYWORDS.has(tk.text) && !this.st.objectKey[k]))
      ) {
        return k
      }
    }
    return close
  }

  /**
   * 组内 ','/';' 之后的元素是否另起一行。分隔式展开组总是断行；
   * 悬挂式保留源码换行，元素内部自己会断行时把超宽交给元素自己的
   * 断点（否则前导分隔符会孤零零留在行尾），其余情况仅当元素续在
   * 本行会超宽时补断。
   */
  private separatorBreaks(nl: number, i: number): boolean {
    const g = this.groups[this.groups.length - 1]
    if (!g?.expanded) return false
    if (!g.hanging) return true
    if (nl > 0) return true
    return !this.elementBreaks(i) && this.elementOverflow(i)
  }

  /**
   * 悬挂组内从 tokens[j] 起的当前元素内部是否会断行（按源码推断）。
   * 元素到同层的下一个分隔符或闭括号为止；嵌套组递归用 groupBreaks
   * 判断（不会断行的组渲染为单行，整组跳过）。判断与 decideBreak
   * 的断点保持一致：行首管道/双目运算符/子句关键字、对象键冒号后的
   * 换行、注释。
   */
  private elementBreaks(j: number): boolean {
    const cap = Math.min(this.tokens.length, j + MAX_SEGMENT_LOOKAHEAD)
    for (let k = j; k < cap; k++) {
      const tk = this.tokens[k]
      if (k > j) {
        if (tk.type === 'comment') return true
        // 元素边界：同层分隔符或闭括号
        if (tk.type === 'operator' && (tk.text === ',' || tk.text === ';' || CLOSERS.has(tk.text))) {
          return false
        }
        const prev = this.tokens[k - 1]
        const nl = newlinesBetween(prev, tk)
        if (nl <= 0) continue
        // 源码此处有换行：落在合法断点上才会真的断行
        if (tk.type === 'operator' && (tk.text === '|' || this.isBinop(tk))) return true
        if (tk.type === 'keyword' && CLAUSE_KEYWORDS.has(tk.text) && !this.st.objectKey[k]) {
          return true
        }
        // 对象键的冒号之后换行：值另起一行（decideBreak 的对象冒号规则）
        if (prev.type === 'operator' && prev.text === ':') return true
        // 子句关键字之后换行：分支内容另起一行（见 decideBreak）
        if (prev.type === 'keyword' && CLAUSE_KEYWORDS.has(prev.text)) return true
      } else if (tk.type === 'operator' && (tk.text === ',' || tk.text === ';')) {
        return false // 空元素（j 本身就是分隔符）
      }
      if (tk.type === 'operator' && OPENERS.has(tk.text)) {
        // 嵌套组：组内会断行则元素内部断行；否则整组跳过（渲染为单行）
        const innerClose = this.match.get(k)!
        if (this.groupBreaks(k, innerClose)) return true
        k = innerClose // 跳过整个嵌套组
      }
    }
    return false
  }

  /** 悬挂组内：当前元素续在本行是否会超宽（1 是元素前的一个空格） */
  private elementOverflow(i: number): boolean {
    const seg = this.segmentWidth(i)
    return seg === Infinity || this.out.col() + 1 + seg > this.opts.printWidth
  }

  // -- 子句栈 --------------------------------------------------------------

  /** 最近的 kind 子句所在行的缩进；没有则为 null。 */
  private findClauseIndent(kind: 'if' | 'try'): number | null {
    for (let p = this.clauses.length - 1; p >= 0; p--) {
      if (this.clauses[p].kind === kind) return this.clauses[p].indent
    }
    return null
  }

  /** 弹出最近的 kind 子句（'end' 弹 if,'catch' 弹 try）。 */
  private popClause(kind: 'if' | 'try'): void {
    for (let p = this.clauses.length - 1; p >= 0; p--) {
      if (this.clauses[p].kind === kind) {
        this.clauses.length = p
        return
      }
    }
  }
}
