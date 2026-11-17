/**
 * 布局层:单遍扫描 token 流,决定断行、缩进与括号组展开。
 *
 * Layout 类持有全部语法上下文(括号组栈、子句栈、def 记账),
 * 行发射委托给 LineBuilder,token 间距规则来自 spacing.ts。
 * 本文件还提供 matchBrackets —— 括号配对是结构分析而非词法,
 * 属于格式化器的职责。
 */

import { FormatError, type FormatOptions } from './api'
import { LineBuilder, trimLineEnd } from './emit'
import {
  CLAUSE_KEYWORDS,
  CLOSERS,
  OPENERS,
  gapBetween,
  isObjectKey,
  type FmtToken
} from './spacing'

/**
 * 断点搜索的向前看上限(token 数)。从某个 token 起最多看这么多
 * token 仍找不到合法断点,就把直到文件尾的余下部分视为一个片段:
 * 它会被当作不可分割的单行输出(括号组内部仍照常展开),以此
 * 避免对病态长输入做平方级扫描。
 */
const MAX_SEGMENT_LOOKAHEAD = 200

/** 括号组('(' / '[' / '{')的布局上下文 */
interface GroupCtx {
  kind: '(' | '[' | '{'
  /** 是否展开为多行(每元素一行) */
  expanded: boolean
  /** 组关闭时要恢复的 ctxIndent */
  savedIndent: number
  /**
   * 开括号所在行的缩进层级。展开组的闭括号回到这一层级 ——
   * 管道断行后该行比 ctxIndent 深一层,组内容与闭括号必须跟着
   * 它,而不是管道前的上下文。
   */
  closeIndent: number
}

/** if/try 子句的布局上下文 */
interface ClauseCtx {
  kind: 'if' | 'try'
  /** 'if'/'try' 所在行的缩进层级 */
  indent: number
}

/**
 * def 语句的记账:把"头部待定、冒号归属、函数体缩进"三件事收在
 * 一个对象里,代替原先散装的三四个标志位。
 */
interface DefCtx {
  /**
   * 正在等待头部 ':' 的 def 所在的括号深度;'def' 后面必须紧跟
   * IDENT 和 ':'/'(' 才算真正的定义(排除 `{def: 1}` 这类对象键),
   * 否则为 null。
   */
  pendingDepth: number | null
  /** 最近一个 ':' 是否属于 def 头部(其后允许断行) */
  lastColonWasDef: boolean
  /** 已进入函数体的 def:记录进入时的缩进,遇到配对的 ';' 时恢复 */
  stack: { depth: number; savedIndent: number }[]
}

/** 断行决策:levels 为 null 表示不断行;blank 表示断行前保留一个空行 */
interface BreakDecision {
  levels: number | null
  blank: boolean
}

function countNewlines(s: string): number {
  let n = 0
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++
  return n
}

const BRACKET_PAIR: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/**
 * 为每个开括号 token 求出配对的闭括号 token 下标;
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

export class Layout {
  // -- 语法上下文 --
  private readonly groups: GroupCtx[] = []
  private readonly clauses: ClauseCtx[] = []
  private readonly def: DefCtx = { pendingDepth: null, lastColonWasDef: false, stack: [] }

  // -- 游标状态 --
  /** 当前上下文中新行的缩进层级 */
  private ctxIndent = 0
  /** 行尾注释吃掉本行后留下的强制断行 */
  private pendingForcedBreak = false
  private prevReal: FmtToken | undefined
  private lastRealEndLine = -1
  private lastAnyEndLine = -1

  constructor(
    private readonly tokens: FmtToken[],
    private readonly match: Map<number, number>,
    private readonly opts: FormatOptions,
    private readonly out: LineBuilder
  ) {}

  run(): void {
    for (let i = 0; i < this.tokens.length; i++) {
      const t = this.tokens[i]

      if (t.type === 'comment') {
        this.emitComment(t)
        continue
      }

      // 距上一个代码 token 的换行数。文件以注释开头(还没有任何代码
      // token)时改用最后一个注释的位置度量,让注释块和首个 def 之间
      // 的空行在格式化后得以保留,而不是被悄悄丢掉。
      const nl = this.prevReal
        ? t.line - this.lastRealEndLine
        : this.lastAnyEndLine >= 0
          ? t.line - this.lastAnyEndLine
          : 0
      const forced = this.pendingForcedBreak
      this.pendingForcedBreak = false

      const d = this.decideBreak(i, nl, forced)

      // -- 发射 --
      if (d.levels !== null) {
        if (this.out.hasContent) this.out.finishLine()
        const last = this.out.lastLine()
        if (d.blank && last !== undefined && last !== '') this.out.addBlankLine()
        this.out.startLine(d.levels)
        this.out.append(t.text, false)
      } else {
        const space = this.prevReal
          ? gapBetween(this.prevReal, t, this.enclosingKind) === 'space'
          : false
        this.out.append(t.text, space)
      }

      // -- 记账:语法上下文与游标 --
      this.updateContexts(t, i)
      this.prevReal = t
      this.lastRealEndLine = t.line + countNewlines(t.text)
      this.lastAnyEndLine = this.lastRealEndLine
    }
    if (this.out.hasContent) this.out.finishLine()
  }

  /** 内层开括号字符('(' / '[' / '{'),语句级为 '' */
  private get enclosingKind(): string {
    const g = this.groups[this.groups.length - 1]
    return g ? g.kind : ''
  }

  private emitComment(t: FmtToken): void {
    const text = trimLineEnd(t.text)
    if (t.line === this.lastAnyEndLine && this.lastAnyEndLine >= 0) {
      // 行尾注释:留在当前行,并吃掉这一行剩下的部分
      this.out.appendTrailingComment(text)
      this.pendingForcedBreak = true
    } else {
      // 独立注释:独占一行,缩进与当前上下文一致
      this.out.addStandaloneLine(this.ctxIndent, text)
    }
    // 续行注释(行尾奇数个反斜杠)本身横跨多行
    this.lastAnyEndLine = t.line + countNewlines(t.text)
  }

  /**
   * 断行决策(先命中先生效):
   *   1. 当前 token 自身('|'、闭括号、子句关键字、def);
   *   2. 前一个代码 token 之后(';'/','/':'/开括号);
   *   3. 行尾注释留下的强制断行。
   */
  private decideBreak(i: number, nl: number, forced: boolean): BreakDecision {
    const t = this.tokens[i]
    const innerGroup = this.groups[this.groups.length - 1]
    const inlineInnermost = this.groups.length > 0 && !innerGroup.expanded
    // `{if: 1}` —— 关键字作为对象键,不是子句/def 关键字
    const objectKey = isObjectKey(this.tokens, i)

    let levels: number | null = null
    let blank = false

    if (t.type === 'operator') {
      if (t.text === '|') {
        // 管道:源码此处有换行,或下一片段放不进本行,则以行首 '|'
        // 断行(比上下文深一层)
        if (!inlineInnermost && (nl > 0 || this.pipeOverflow(i))) {
          levels = this.ctxIndent + 1
        }
      } else if (CLOSERS.has(t.text)) {
        // 展开组的闭括号:回到开括号所在行的层级
        if (innerGroup && innerGroup.expanded) levels = innerGroup.closeIndent
      }
    } else if (t.type === 'keyword' && !objectKey) {
      if (CLAUSE_KEYWORDS.has(t.text)) {
        // 子句关键字:源码有换行或行宽不够时,回到 if/try 所在行的层级
        if (!inlineInnermost && (nl > 0 || this.clauseOverflow(i))) {
          levels = this.findClauseIndent(t.text === 'catch' ? 'try' : 'if') ?? this.ctxIndent
        }
      } else if (t.text === 'def' && i > 0) {
        // def 总是从新行开始,与上文之间最多保留一个空行
        levels = this.ctxIndent
        blank = nl >= 2
      }
    }

    if (levels === null && this.prevReal) {
      const p = this.prevReal
      if (p.type === 'operator') {
        if (p.text === ';') {
          // def 结束的 ';':语句级回到 ctxIndent 并保留空行;展开组内也断行
          if (this.groups.length === 0) {
            levels = this.ctxIndent
            blank = nl >= 2
          } else if (this.groups[this.groups.length - 1].expanded) {
            levels = this.ctxIndent
          }
        } else if (p.text === ',') {
          // 逗号:语句级保留源码换行;展开组内每元素一行
          if (this.groups.length === 0) {
            if (nl > 0) levels = this.ctxIndent
          } else if (this.groups[this.groups.length - 1].expanded) {
            levels = this.ctxIndent
          }
        } else if (p.text === ':' && this.def.lastColonWasDef) {
          // def 头部的 ':' 之后:所有括号组都展开时才允许换行
          if (nl > 0 && this.groups.every((g) => g.expanded)) levels = this.ctxIndent
        } else if (OPENERS.has(p.text)) {
          // 展开组的开括号之后:第一个元素另起一行
          if (this.groups[this.groups.length - 1]?.expanded) levels = this.ctxIndent
        }
      }
    }

    if (levels === null && forced) {
      // 注释尾随在 '|' 之后时,管道继续以 pipe 层断行
      levels =
        this.prevReal && this.prevReal.type === 'operator' && this.prevReal.text === '|'
          ? this.ctxIndent + 1
          : this.ctxIndent
    }

    return { levels, blank }
  }

  /**
   * 发射 token 之后的语法记账:括号组进出、def 头部/函数体缩进、
   * if/try 子句栈。
   */
  private updateContexts(t: FmtToken, i: number): void {
    // `{if: 1}` —— 关键字作为对象键,不触发任何语法记账
    const objectKey = isObjectKey(this.tokens, i)

    if (t.type === 'operator') {
      if (OPENERS.has(t.text)) {
        const expanded = this.decideExpanded(i)
        this.groups.push({
          kind: t.text as '(' | '[' | '{',
          expanded,
          savedIndent: this.ctxIndent,
          closeIndent: this.out.indentLevel
        })
        if (expanded) {
          this.ctxIndent = this.out.indentLevel + 1
          this.pendingForcedBreak = true
        }
      } else if (CLOSERS.has(t.text)) {
        const g = this.groups.pop()
        if (g) this.ctxIndent = g.savedIndent
      } else if (t.text === ':') {
        if (this.def.pendingDepth !== null && this.groups.length === this.def.pendingDepth) {
          // def 头部的 ':':进入函数体,缩进 +1,遇到配对的 ';' 恢复
          this.def.stack.push({ depth: this.def.pendingDepth, savedIndent: this.ctxIndent })
          this.ctxIndent++
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
        // 只有真正的定义:'def' IDENT (':' | '(' …)
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
        this.clauses.push({ kind: 'if', indent: this.out.indentLevel })
      } else if (t.text === 'try') {
        this.clauses.push({ kind: 'try', indent: this.out.indentLevel })
      } else if (t.text === 'end') {
        this.popClause('if')
      } else if (t.text === 'catch') {
        this.popClause('try')
      }
    }
  }

  // -- 行宽测量 -----------------------------------------------------------
  //
  // flatSpan / segmentWidth 在每次断行决策时各被调用常数次,每次为
  // 片段长度的线性开销;findSegmentEnd 以 MAX_SEGMENT_LOOKAHEAD 封顶,
  // 整体不会超出单遍扫描的常数倍。

  /** 把 tokens[start, end) 试排成一行;片段含注释时返回 null。 */
  private flatSpan(start: number, end: number, hint: string): string | null {
    let out = ''
    const stack: string[] = []
    for (let k = start; k < end; k++) {
      const tk = this.tokens[k]
      if (tk.type === 'comment') return null
      const prev = k > start ? this.tokens[k - 1] : undefined
      const enclosing = stack.length ? stack[stack.length - 1] : hint
      if (prev && gapBetween(prev, tk, enclosing) === 'space') out += ' '
      out += tk.text
      if (tk.type === 'operator' && OPENERS.has(tk.text)) stack.push(tk.text)
      else if (tk.type === 'operator' && CLOSERS.has(tk.text)) stack.pop()
    }
    return out
  }

  /** 从 j 起第一个合法断点(不含 j 自身)的下标。 */
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
          if (
            tk.type === 'keyword' &&
            (CLAUSE_KEYWORDS.has(tk.text) || tk.text === 'def') &&
            !isObjectKey(this.tokens, k)
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

  /** 从 j 起下一个片段的单行宽度;含注释(不可平铺)时为无穷。 */
  private segmentWidth(j: number): number {
    // 前置的行尾注释贴在当前行上,不计入其后片段的宽度
    let start = j
    while (start < this.tokens.length && this.tokens[start].type === 'comment') start++
    const flat = this.flatSpan(start, this.findSegmentEnd(start), '')
    return flat === null ? Infinity : flat.length
  }

  /** '|' 之后的片段是否会超出行宽(3 是 ' | ' 的宽度)。 */
  private pipeOverflow(i: number): boolean {
    const seg = this.segmentWidth(i + 1)
    return seg === Infinity || this.out.col() + 3 + seg > this.opts.printWidth
  }

  /** 子句关键字之后的片段是否会超出行宽。 */
  private clauseOverflow(i: number): boolean {
    const t = this.tokens[i]
    if (t.text !== 'then' && t.text !== 'elif' && t.text !== 'else') return false
    const seg = this.segmentWidth(i + 1)
    return seg === Infinity || this.out.col() + t.text.length + 1 + seg > this.opts.printWidth
  }

  /** tokens[i] 的开括号组是否应展开为多行。 */
  private decideExpanded(i: number): boolean {
    const close = this.match.get(i)!
    if (close === i + 1) return false // 空组 '{}'
    let prevEnd = this.tokens[i].line
    for (let k = i + 1; k < close; k++) {
      const tk = this.tokens[k]
      if (tk.line > prevEnd) return true // 源码在组内有换行
      if (tk.type === 'comment') return true // 注释迫使展开
      prevEnd = tk.line + countNewlines(tk.text)
    }
    if (this.tokens[close].line > prevEnd) return true
    const flat = this.flatSpan(i + 1, close, this.tokens[i].text)
    if (flat === null) return true
    // 平铺后放不进本行
    return this.out.col() + flat.length + 1 > this.opts.printWidth
  }

  // -- 子句栈 --------------------------------------------------------------

  /** 最近的 kind 子句所在行的缩进;没有则为 null。 */
  private findClauseIndent(kind: 'if' | 'try'): number | null {
    for (let p = this.clauses.length - 1; p >= 0; p--) {
      if (this.clauses[p].kind === kind) return this.clauses[p].indent
    }
    return null
  }

  /** 弹出最近的 kind 子句('end' 弹 if,'catch' 弹 try)。 */
  private popClause(kind: 'if' | 'try'): void {
    for (let p = this.clauses.length - 1; p >= 0; p--) {
      if (this.clauses[p].kind === kind) {
        this.clauses.length = p
        return
      }
    }
  }
}
