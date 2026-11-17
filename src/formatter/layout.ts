/**
 * 布局层（decide 引擎）：单遍扫描 token 流，决定断行、缩进与括号组
 * 展开。Layout 类持有全部语法上下文（括号组栈、子句栈、def 记账），
 * 行发射委托给 LineBuilder，token 间距规则来自 spacing.ts，token 流
 * 派生信息来自 tokens.ts；「假如这样排会怎样」的推测（组风格、宽度
 * 预算）委托给 measure.ts 与 predict.ts —— 两侧共用的断点词汇表与
 * 有意不对称的契约见 breakkind.ts 头注释。
 */

import type { FormatOptions } from './api'
import { breakAfter, breakBefore } from './breakkind'
import { LineBuilder, trimLineEnd } from './emit'
import { Measure } from './measure'
import { Predict } from './predict'
import { CLOSERS, OPENERS, gapBetween, padsInsideBracket, type FmtToken } from './spacing'
import { TokenStream, endCol, endLine, newlinesBetween } from './tokens'

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
  /**
   * 组内是否已出现顶层 ','/';'（发射顺序记账）。悬挂组里开括号行上
   * 挂下来的运算符链与开括号竖向对齐；一旦出现顶层分隔符，后续的
   * 管道就是元素内部结构，回到「比上下文深一层」的常规缩进。
   */
  seenSep: boolean
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
  readonly #groups: GroupCtx[] = []
  readonly #clauses: ClauseCtx[] = []
  readonly #def: DefCtx = { pendingDepth: null, lastColonWasDef: false, stack: [] }

  // -- 游标状态 --
  /** 当前上下文中新行的缩进列数 */
  #ctxIndent = 0
  /** 行尾注释吃掉本行后留下的强制断行 */
  #pendingForcedBreak = false
  /**
   * 正在 if/try 子句的分支里：分支内容的缩进，以及进入分支时的括号
   * 深度（深度变化说明注释/内容已进入更深的括号组，不再用分支缩进）。
   * 分支里的独立注释与分支内容对齐到同一缩进。
   */
  #bodyIndent: { indent: number; depth: number } | null = null
  #prevReal: FmtToken | undefined
  /** prevReal 在 token 流中的下标（-1 = 还没有）；跳过注释 */
  #prevRealIdx = -1
  /** 上一个已发射内容（代码 token 或注释）的结束行号 */
  #lastAnyEndLine = -1

  readonly #st: TokenStream
  readonly #opts: FormatOptions
  readonly #out: LineBuilder
  /** 行宽测量（见 measure.ts） */
  readonly #m: Measure
  /** 源码断行推断（见 predict.ts） */
  readonly #predict: Predict
  /** 便捷别名：token 序列是最高频的访问 */
  readonly #tokens: readonly FmtToken[]

  constructor(st: TokenStream, opts: FormatOptions, out: LineBuilder) {
    this.#st = st
    this.#opts = opts
    this.#out = out
    this.#tokens = st.tokens
    // 行宽测量：col 回调让测量读到活的发射进度，又不触碰发射状态
    this.#m = new Measure(st, opts, () => out.col())
    // 源码断行推断：与测量共用 token 流，同样只读发射进度
    this.#predict = new Predict(st, opts, this.#m, () => out.col())
  }

  run(): void {
    for (let i = 0; i < this.#tokens.length; i++) {
      const t = this.#tokens[i]

      if (t.type === 'comment') {
        this.#emitComment(t)
        continue
      }

      // 距上一个已发射内容（代码 token 或注释）的换行数。统一用
      // lastAnyEndLine 度量：若跨过独立注释测到上一个代码 token,
      // 注释自身占的行会被误计成空行。
      const nl = this.#lastAnyEndLine >= 0 ? t.line - this.#lastAnyEndLine : 0
      // 源码空行原样保留（封顶 MAX_BLANK_LINES 个），绝不凭空增加
      const blanks = this.#blankCount(t.line)
      const forced = this.#pendingForcedBreak
      this.#pendingForcedBreak = false

      const d = this.#decideBreak(i, nl, forced)

      // -- 发射 --
      if (d.indent !== null) {
        if (this.#out.hasContent) this.#out.finishLine()
        this.#emitBlanks(blanks)
        this.#out.startLine(d.indent)
        this.#out.append(t.text, false)
      } else {
        // 独立注释之后另起的内容行：源码空行同样保留
        if (!this.#out.hasContent) this.#emitBlanks(blanks)
        const space = this.#prevReal
          ? gapBetween(this.#prevReal, t, this.#enclosingKind) === 'space' ||
            padsInsideBracket(this.#prevReal, t, this.#groups[this.#groups.length - 1] ?? null)
          : false
        this.#out.append(t.text, space)
      }

      // -- 记账：语法上下文与游标 --
      this.#updateContexts(t, i)
      this.#prevReal = t
      this.#prevRealIdx = i
      this.#lastAnyEndLine = endLine(t)
    }
    if (this.#out.hasContent) this.#out.finishLine()
  }

  /** line 与上一内容之间的源码空行数，封顶 MAX_BLANK_LINES */
  #blankCount(line: number): number {
    if (this.#lastAnyEndLine < 0) return 0
    return Math.min(Math.max(line - this.#lastAnyEndLine - 1, 0), MAX_BLANK_LINES)
  }

  /** 输出 n 个空行；不紧跟在空行或文件头之后 */
  #emitBlanks(n: number): void {
    if (n <= 0) return
    const last = this.#out.lastLine()
    if (last !== undefined && last !== '') this.#out.addBlankLines(n)
  }

  /** 内层开括号字符（'(' / '[' / '{'），语句级为 '' */
  get #enclosingKind(): string {
    const g = this.#groups[this.#groups.length - 1]
    return g ? g.kind : ''
  }

  /**
   * 悬挂组内、尚未出现顶层分隔符时，挂在开括号行上的运算符链与
   * 开括号所在行的行首竖向对齐（开括号在行首时即与开括号同列）；
   * 其余情况返回 null，走各断点自己的常规缩进。
   */
  #hangingChainAlign(g: GroupCtx | undefined): number | null {
    return g?.hanging && !g.seenSep ? g.closeIndent : null
  }

  #emitComment(t: FmtToken): void {
    const text = trimLineEnd(t.text)
    if (t.line === this.#lastAnyEndLine && this.#lastAnyEndLine >= 0) {
      // 行尾注释：留在当前行，并吃掉这一行剩下的部分。
      // 与前面代码的间距按源码原样保留，不足一个空格则补一个。
      const gap = this.#prevReal ? t.col - endCol(this.#prevReal) : 1
      this.#out.appendTrailingComment(text, Math.max(gap, 1))
      this.#pendingForcedBreak = true
    } else {
      // 独立注释：独占一行，缩进与当前上下文一致；正处某个子句分支
      // 里（且未进入更深的括号组）时，对齐到分支内容的缩进。
      // 与上一个输出之间的源码空行原样保留。先结束未完的当前行，
      // 空行才能落在它和注释之间。
      if (this.#out.hasContent) this.#out.finishLine()
      this.#emitBlanks(this.#blankCount(t.line))
      const indent =
        this.#bodyIndent !== null && this.#bodyIndent.depth === this.#groups.length
          ? this.#bodyIndent.indent
          : this.#ctxIndent
      this.#out.addStandaloneLine(indent, text)
    }
    // 续行注释（行尾奇数个反斜杠）本身横跨多行
    this.#lastAnyEndLine = endLine(t)
  }

  /**
   * 断行决策（先命中先生效）：
   *   1. 当前 token 自身是断点 token（词汇见 breakkind.ts）；
   *   2. 前一个代码 token 之后是断点（跳过注释）；
   *   3. 行尾注释留下的强制断行。
   */
  #decideBreak(i: number, nl: number, forced: boolean): BreakDecision {
    const t = this.#tokens[i]
    const innerGroup = this.#groups[this.#groups.length - 1]
    const inlineInnermost = this.#groups.length > 0 && !innerGroup.expanded

    let indent: number | null = null

    // 相位 1：当前 token 自身
    switch (breakBefore(this.#st, i)) {
      case 'pipe': {
        // 管道：源码此处有换行，或下一片段放不进本行，则以行首 '|'
        // 断行。尾随风格（'|' 之后源码已换行）不抢断：下一片段反正
        // 会另起一行，交给 afterBinop 按源码保留。缩进：悬挂组里挂
        // 在开括号行上的运算符链与开括号竖向对齐（同加号等行首双目
        // 运算符的既有风格），其余（语句级、分隔式组、组内元素内部）
        // 比上下文深一层
        const next = this.#tokens[i + 1]
        const trailing = !!next && newlinesBetween(t, next) > 0
        if (!inlineInnermost && (nl > 0 || (this.#m.pipeOverflow(i) && !trailing))) {
          indent = this.#hangingChainAlign(innerGroup) ?? this.#ctxIndent + this.#opts.indentSize
        }
        break
      }
      case 'closer':
        // 展开组的闭括号：前导分隔符风格的悬挂组回到开括号所在列，
        // 其余悬挂组与分隔式回到开括号所在行的行首；悬挂式且源码闭括号
        // 未换行时，留在最后一个元素所在的行内
        if (innerGroup && innerGroup.expanded && !(innerGroup.hanging && nl === 0)) {
          indent =
            innerGroup.hanging && innerGroup.leadSep ? innerGroup.alignCol : innerGroup.closeIndent
        }
        break
      case 'binop': {
        // 双目运算符（含关键字 and/or）：源码此处有换行，或其后的
        // 片段放不进本行，则以行首运算符断行，与本行（表达式起始行）
        // 同层 —— 悬挂组内即与开括号竖向对齐。尾随风格（运算符之后
        // 源码已换行）不抢断，理由同 pipe
        const next = this.#tokens[i + 1]
        const trailing = !!next && newlinesBetween(t, next) > 0
        if (!inlineInnermost && (nl > 0 || (this.#m.operatorOverflow(i) && !trailing))) {
          indent = this.#hangingChainAlign(innerGroup) ?? this.#out.indentCols
        }
        break
      }
      case 'leadSep':
        // 前导分隔符：悬挂组里源码在 ','/';' 之前换行时，分隔符提到
        // 行首，与开括号同列对齐（与前导双目运算符同一种风格，
        // jq 源码里常见）
        if (
          innerGroup !== undefined &&
          innerGroup.expanded &&
          innerGroup.hanging &&
          nl > 0
        ) {
          indent = innerGroup.alignCol
        }
        break
      case 'clause':
        // 子句关键字：源码有换行或行宽不够时，回到 if/try 所在行的行首
        if (!inlineInnermost && (nl > 0 || this.#m.clauseOverflow(i))) {
          indent = this.#findClauseIndent(t.text === 'catch' ? 'try' : 'if') ?? this.#ctxIndent
        }
        break
      case 'def': {
        // def 总是从新行开始（空行保留与断行原因无关，统一按源码处理）；
        // 例外：悬挂式开括号行上的 def（否则悬挂排列被破坏，反复格式化
        // 结果不稳定），以及未展开组内的 def（组保持单行）
        const p = this.#prevReal
        const afterHangingOpener =
          !!p &&
          p.type === 'operator' &&
          OPENERS.has(p.text) &&
          (this.#groups[this.#groups.length - 1]?.hanging ?? false)
        if (!afterHangingOpener && !inlineInnermost) indent = this.#ctxIndent
        break
      }
      case 'reduce':
        // reduce/foreach 分组的 '('：源码在 as 绑定模式之后换行时
        // 原样保留，缩进比 as 所在行深一层。不主动断行 —— 组自身
        // 的展开与分隔符断行自会处理超宽
        if (nl > 0) indent = this.#out.indentCols + this.#opts.indentSize
        break
    }

    // 相位 2：前一个代码 token 之后（prevRealIdx 跳过注释）
    if (indent === null && this.#prevRealIdx >= 0) {
      const p = this.#tokens[this.#prevRealIdx]
      switch (breakAfter(this.#st, this.#prevRealIdx)) {
        case 'afterSep':
          if (p.text === ';') {
            // def 结束的 ';'：语句级回到 ctxIndent；组内按组风格断行
            if (this.#groups.length === 0) {
              indent = this.#ctxIndent
            } else if (this.#separatorBreaks(nl, i)) {
              indent = this.#ctxIndent
            }
          } else {
            // 逗号：语句级保留源码换行；组内按组风格断行
            if (this.#groups.length === 0) {
              if (nl > 0) indent = this.#ctxIndent
            } else if (this.#separatorBreaks(nl, i)) {
              indent = this.#ctxIndent
            }
          }
          break
        case 'afterColon':
          if (this.#def.lastColonWasDef) {
            // def 头部的 ':' 之后：所有括号组都展开时才允许换行
            if (nl > 0 && this.#groups.every((g) => g.expanded)) indent = this.#ctxIndent
          } else if (
            this.#enclosingKind === '{' &&
            innerGroup !== undefined &&
            innerGroup.expanded &&
            nl > 0
          ) {
            // 对象键的冒号之后：源码换行处保留，值比键所在行深一层
            indent = this.#out.indentCols + this.#opts.indentSize
          }
          break
        case 'afterOpener': {
          // 分隔式展开组的开括号之后：第一个元素另起一行（悬挂式不断）
          const g = this.#groups[this.#groups.length - 1]
          if (g?.expanded && !g.hanging) indent = this.#ctxIndent
          break
        }
        case 'afterClause':
          // 子句关键字之后源码换行：分支内容另起一行，缩进为分支缩进
          //（比子句关键字所在层与上下文层的较大者深一层）；elif 后是
          // 条件而非分支，回到上下文缩进。'end' 之后不另起分支行。
          if (p.text !== 'end' && nl > 0) indent = this.#bodyIndent?.indent ?? this.#ctxIndent
          break
        case 'afterBinop':
          // 双目运算符/管道之后（尾随风格）源码换行：操作数另起一行，
          // 尊重源码的折行选择。缩进与对应的行首风格一致（见上方
          // pipe / binop 两个相位 1 分支）
          if (nl > 0) {
            indent =
              p.text === '|'
                ? this.#hangingChainAlign(innerGroup) ?? this.#ctxIndent + this.#opts.indentSize
                : this.#hangingChainAlign(innerGroup) ?? this.#out.indentCols
          }
          break
      }
    }

    if (indent === null && forced) {
      // 注释尾随在 '|' 之后时，管道继续以 pipe 层断行（悬挂组内同样
      // 对齐开括号）
      indent =
        this.#prevReal && this.#prevReal.type === 'operator' && this.#prevReal.text === '|'
          ? this.#hangingChainAlign(innerGroup) ?? this.#ctxIndent + this.#opts.indentSize
          : this.#ctxIndent
    }

    return { indent }
  }

  /**
   * 发射 token 之后的语法记账：括号组进出、def 头部/函数体缩进、
   * if/try 子句栈。
   */
  #updateContexts(t: FmtToken, i: number): void {
    // `{if: 1}` —— 关键字作为对象键，不触发任何语法记账
    const objectKey = this.#st.objectKey[i]

    if (t.type === 'operator') {
      if (OPENERS.has(t.text)) {
        const style = this.#predict.groupStyle(i)
        this.#groups.push({
          kind: t.text as '(' | '[' | '{',
          expanded: style.expanded,
          hanging: style.hanging,
          savedIndent: this.#ctxIndent,
          closeIndent: this.#out.indentCols,
          // 开括号刚发射完毕：其起始列 = 当前行末列减去自身宽度
          alignCol: this.#out.col() - t.text.length,
          leadSep: style.leadSep,
          seenSep: false
        })
        if (style.expanded) {
          this.#ctxIndent = this.#out.indentCols + this.#opts.indentSize
          // 分隔式：开括号后第一个元素另起一行；悬挂式不断
          if (!style.hanging) this.#pendingForcedBreak = true
        }
      } else if (CLOSERS.has(t.text)) {
        const g = this.#groups.pop()
        if (g) this.#ctxIndent = g.savedIndent
      } else if (t.text === ',' || t.text === ';') {
        // 顶层分隔符：此后悬挂组内的管道属于元素内部结构，
        // 不再对齐开括号（见 hangingChainAlign）
        const g = this.#groups[this.#groups.length - 1]
        if (g) g.seenSep = true
        if (t.text === ';') {
          const top = this.#def.stack[this.#def.stack.length - 1]
          if (top && top.depth === this.#groups.length)
            this.#ctxIndent = this.#def.stack.pop()!.savedIndent
        }
      } else if (t.text === ':') {
        if (this.#def.pendingDepth !== null && this.#groups.length === this.#def.pendingDepth) {
          // def 头部的 ':'：进入函数体，缩进一层，遇到配对的 ';' 恢复
          this.#def.stack.push({ depth: this.#def.pendingDepth, savedIndent: this.#ctxIndent })
          this.#ctxIndent += this.#opts.indentSize
          this.#def.lastColonWasDef = true
          this.#def.pendingDepth = null
        } else {
          this.#def.lastColonWasDef = false
        }
      } else if (t.text === ';') {
        const top = this.#def.stack[this.#def.stack.length - 1]
        if (top && top.depth === this.#groups.length)
          this.#ctxIndent = this.#def.stack.pop()!.savedIndent
      }
    } else if (t.type === 'keyword' && !objectKey) {
      if (t.text === 'def') {
        // 只有真正的定义：'def' IDENT (':' | '(' …)
        const n1 = this.#tokens[i + 1]
        const n2 = this.#tokens[i + 2]
        this.#def.pendingDepth =
          !!n1 &&
          n1.type === 'ident' &&
          !!n2 &&
          n2.type === 'operator' &&
          (n2.text === ':' || n2.text === '(')
            ? this.#groups.length
            : null
      } else if (t.text === 'if') {
        this.#clauses.push({ kind: 'if', indent: this.#out.indentCols })
        this.#bodyIndent = null
      } else if (t.text === 'try') {
        this.#clauses.push({ kind: 'try', indent: this.#out.indentCols })
        this.#bodyIndent = null
      } else if (t.text === 'then' || t.text === 'else') {
        // 进入 if 分支：分支内容比「子句关键字所在层与上下文层的
        // 较大者」再深一层
        const clause = this.#findClauseIndent('if') ?? this.#ctxIndent
        this.#bodyIndent = {
          indent: Math.max(clause, this.#ctxIndent) + this.#opts.indentSize,
          depth: this.#groups.length
        }
      } else if (t.text === 'elif') {
        this.#bodyIndent = null // elif 之后是条件，不是分支
      } else if (t.text === 'end') {
        this.#popClause('if')
        this.#bodyIndent = null
      } else if (t.text === 'catch') {
        const clause = this.#findClauseIndent('try') ?? this.#ctxIndent
        const indent = Math.max(clause, this.#ctxIndent) + this.#opts.indentSize
        this.#popClause('try')
        this.#bodyIndent = { indent, depth: this.#groups.length }
      }
    }
  }

  /**
   * 组内 ','/';' 之后的元素是否另起一行（decide 侧策略：读活的组栈，
   * 故留在本文件）。分隔式展开组总是断行；悬挂式保留源码换行，
   * 元素内部自己会断行时把超宽交给元素自己的断点（否则前导分隔符
   * 会孤零零留在行尾），其余情况仅当元素续在本行会超宽时补断。
   */
  #separatorBreaks(nl: number, i: number): boolean {
    const g = this.#groups[this.#groups.length - 1]
    if (!g?.expanded) return false
    if (!g.hanging) return true
    if (nl > 0) return true
    return !this.#predict.elementBreaks(i) && this.#m.elementOverflow(i)
  }

  // -- 子句栈 --------------------------------------------------------------

  /** 最近的 kind 子句所在行的缩进；没有则为 null。 */
  #findClauseIndent(kind: 'if' | 'try'): number | null {
    for (let p = this.#clauses.length - 1; p >= 0; p--) {
      if (this.#clauses[p].kind === kind) return this.#clauses[p].indent
    }
    return null
  }

  /** 弹出最近的 kind 子句（'end' 弹 if,'catch' 弹 try）。 */
  #popClause(kind: 'if' | 'try'): void {
    for (let p = this.#clauses.length - 1; p >= 0; p--) {
      if (this.#clauses[p].kind === kind) {
        this.#clauses.length = p
        return
      }
    }
  }
}
