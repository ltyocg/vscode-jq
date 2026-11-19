/**
 * AST 打印器 —— 把解析结果按 STYLE.md 的规范发射为文本。
 *
 * 架构：线性 token 游标 + 按构造的递归打印。
 *  - 游标按原始下标顺序发射实 token，途经的注释在「下一个实 token」
 *    发射前冲刷（行尾注释留行尾、独立注释独占一行取下一行缩进），
 *    空行按源码行算术保留（上限 2、绝不新增）。
 *  - 换行是懒的：newline(cols) 只记录意图，首个发射前兑现。这样
 *    「先决定断行、后冲刷行尾注释」的次序问题自然消解 —— 行尾注释
 *    总能挂回它所属的上一行。
 *  - 断行决策只依赖源码换行（作者意图）与当前列的行宽（贪心）。
 *  - 缩进单一来源（home 模型）：每个构造有一个 home＝它作为内容出
 *    现的层级，由 Ctx{base, cont} 显式传递 —— base＝home（构造自身
 *    的括号组、+1 层子内容的锚点），cont＝本构造链断行时行首运算
 *    符的缩进。home 的推导（全部结构化，不回读发射状态）：
 *     · 行首构造：所在行的缩进（与旧「行缩进」模型相等）；
 *     · '|' / 运算符之后的内容：cont＋1 层（segCtx / atCtx ——
 *       `| eval_ast(` 的实参锚在段 home＋1 层）；
 *     · 悬挂组首元素：开括号列＋1 层（＝元素列）；
 *     · 'key: ' 的值、'; ' 之后的查询：条目层级（不开新层）；冒号
 *       断行时值在条目＋1 层；
 *     · 子句关键字 / def 体、reduce 源：关键字列＋1 层。
 *    组的基础缩进＝拥有它的构造的 home（开括号起行时二者相等）。
 *    lineIndent 只剩两处合法读取：printComma 的条目边界、rowCtx
 *    （行首延续的组内非首元素）。
 *  - padNext / forceBreak 是发射游标的一次性标志（悬挂组内侧补位 /
 *    行尾注释后的强制换行），随发射消费，与层级无关。
 *  - 保留 token 文本，仅允许按策略增删对象构造的尾随逗号。
 */
import type { Token } from '../tokenizer'
import { gapBetween } from './spacing'
import { LineBuilder } from './emit'
import type { FormatOptions } from './api'
import type { ParseResult } from './parser/parse'
import { Metrics } from './width'
import type {
  CommaItem,
  CommaNode,
  Expr,
  FuncDefNode,
  ImportNode,
  Node,
  ObjectEntry,
  ObjectKey,
  PatternEntry,
  PatternNode,
  PipeNode,
  Program,
  Query,
  Suffix,
  Term,
  TermInner
} from './parser/ast'

/** 打印上下文：构造的排版基准，由父构造在调用边界上显式给出 */
interface Ctx {
  /** 本构造的 home：它自身的括号组与 +1 层子内容的锚点 */
  base: number
  /** 本构造的链断行时行首运算符的缩进 */
  cont: number
}

export function printProgramResult(r: ParseResult, opts: FormatOptions): string {
  const out = new LineBuilder()
  // 布局开始前就抑制源码尾逗号：外层平铺直接发射内部 token 时也生效。
  const suppressed =
    opts.trailingComma === 'preserve' || r.objectCommas.size === 0 ? undefined : r.objectCommas
  const metrics = new Metrics(r.tokens, r.real, r.unaryAt, opts.printWidth, suppressed)
  new Printer(r.tokens, r.real, r.unaryAt, opts, out, metrics, suppressed).run(r.program)
  // 最后一行内容仍在拼行缓冲里，先落行再收尾（空行由 trim 去掉）
  out.finishLine()
  out.trimTrailingBlankLines()
  return out.join(r.eol) + r.eol
}

class Printer {
  /** 实 token 游标（real 数组下标） */
  #rpos = 0
  /** 已发射/已冲刷的最末 token 原始下标 */
  #through = -1
  #prevReal: number | null = null
  #lastEndLine = -1
  /** 行尾注释之后强制换行（发射游标一次性标志） */
  #forceBreak = false
  /** 悬挂组内侧补位（发射游标一次性标志）：下一个实 token 之前补一个空格 */
  #padNext = false
  /** 懒换行：意图中的下一行缩进 */
  #pending: number | null = null
  /** 当前行已写到的列（多行 token 之后 = 其末行内容宽度） */
  #col = 0
  /** 与发射同步的括号栈（gapBetween 的 enclosing） */
  #stack: string[] = []
  /** 被抑制的 token 原始下标（按策略去掉的对象尾随逗号） */
  readonly #suppressed: ReadonlySet<number> | undefined

  readonly #tokens: Token[]
  readonly #real: number[]
  readonly #unaryAt: Set<number>
  readonly #opts: FormatOptions
  readonly #out: LineBuilder
  readonly #m: Metrics

  constructor(
    tokens: Token[],
    real: number[],
    unaryAt: Set<number>,
    opts: FormatOptions,
    out: LineBuilder,
    m: Metrics,
    suppressed: ReadonlySet<number> | undefined
  ) {
    this.#tokens = tokens
    this.#real = real
    this.#unaryAt = unaryAt
    this.#opts = opts
    this.#out = out
    this.#m = m
    this.#suppressed = suppressed
  }

  get #is(): number {
    return this.#opts.indentSize
  }

  // ==== 游标与发射 ========================================================

  /** 当前行的有效缩进（含未兑现的懒换行）。层级推导只在构造边界经
   *  下述工厂读取；发射层（行尾注释后的强制换行、语句分隔）另计 */
  #lineIndent(): number {
    return this.#pending ?? this.#out.indentCols
  }

  /** 下一段内容若不断行将落到的列 */
  #effCol(): number {
    return this.#pending !== null ? this.#pending : this.#col
  }

  // ---- 构造边界上的上下文工厂 -------------------------------------------

  /** home 与链 cont 同层（行首延续、子句体、冒号断行后的值、链操作数） */
  #atCtx(cols: number): Ctx {
    return { base: cols, cont: cols }
  }

  /** '|' 之后的内容：home＝cont＋1 层（段内组的锚点），链 cont 仍对齐 '|' */
  #segCtx(cont: number): Ctx {
    return { base: cont + this.#is, cont }
  }

  /** 'key: ' 的值等：home＝条目层级，内部链比条目深一层 */
  #nestedCtx(base: number): Ctx {
    return { base, cont: base + this.#is }
  }

  /** 起始于当前行的构造（printComma 的条目边界）：base＝当前行缩进 */
  #lineCtx(cont: number): Ctx {
    return { base: this.#lineIndent(), cont }
  }

  /** 起始于当前行、home 与链 cont 都随该行（拥抱实参、组内非首元素） */
  #rowCtx(): Ctx {
    const cols = this.#lineIndent()
    return { base: cols, cont: cols }
  }

  #newline(cols: number): void {
    this.#pending = cols
  }

  #applyPending(): void {
    if (this.#pending === null) return
    if (this.#out.hasContent) this.#out.finishLine()
    this.#out.startLine(this.#pending)
    this.#col = this.#pending
    this.#pending = null
  }

  /** 发射 [pos, to) 的全部实 token：每个 token 前冲刷途经注释 */
  #emitTo(to: number): void {
    while (this.#rpos < this.#real.length && this.#real[this.#rpos] < to) {
      const idx = this.#real[this.#rpos]
      this.#flushCommentsBefore(idx)
      if (this.#suppressed?.has(idx)) {
        // 去掉的尾随逗号：不发射，但保留为后续间距与行尾注释挂靠的
        // 参照 token（闭括号与它的间距按「贴逗号」计）；它占用的源码
        // 行仍计入空行保持（独占一行的逗号被去掉不得凭空多出空行）
        this.#prevReal = idx
        this.#through = idx
        this.#lastEndLine = this.#m.endLine(idx)
        this.#rpos++
        continue
      }
      this.#emitReal(idx)
      this.#rpos++
    }
  }

  /** 发射文件尾部残余注释（最后一个实 token 之后的） */
  #flushTrailing(): void {
    for (let i = this.#through + 1; i < this.#tokens.length; i++) {
      if (this.#tokens[i]!.type === 'comment') this.#flushComment(i)
    }
  }

  #emitReal(idx: number): void {
    const tk = this.#tokens[idx]
    // 行尾注释之后的强制换行（懒换行兑现；已有断行意图则不覆盖）
    if (this.#forceBreak) {
      this.#forceBreak = false
      if (this.#out.hasContent && this.#pending === null) this.#newline(this.#lineIndent())
    }
    this.#applyPending()
    // 空行保持（新行首才有可能；lastEndLine ≥ 0 才有「上文」）
    if (!this.#out.hasContent && this.#lastEndLine >= 0) {
      const blanks = tk.line - this.#lastEndLine - 1
      if (blanks > 0) this.#out.addBlankLines(Math.min(2, blanks))
    }
    const enclosing = this.#stack.length > 0 ? this.#stack[this.#stack.length - 1]! : ''
    const prev = this.#prevReal !== null ? this.#toFmt(this.#prevReal) : undefined
    const pad = this.#padNext
    this.#padNext = false
    const space =
      prev !== undefined &&
      this.#out.hasContent &&
      (gapBetween(prev, this.#toFmt(idx), enclosing) === 'space' || pad)
    this.#out.append(tk.text, space)
    this.#advanceCol(tk.text, space)
    // 括号栈同步（发射之后：闭括号弹出自己那层，开括号压入）
    if (tk.type === 'operator') {
      if (tk.text === '(' || tk.text === '[' || tk.text === '{') this.#stack.push(tk.text)
      else if (tk.text === ')' || tk.text === ']' || tk.text === '}') this.#stack.pop()
    }
    this.#prevReal = idx
    this.#through = idx
    this.#lastEndLine = this.#m.endLine(idx)
  }

  /** 发射后推进列（多行 token：取末行内容宽度） */
  #advanceCol(text: string, space: boolean): void {
    const nl = text.lastIndexOf('\n')
    if (nl >= 0) this.#col = text.length - nl - 1
    else this.#col += (space ? 1 : 0) + text.length
  }

  #toFmt(idx: number) {
    const t = this.#tokens[idx]
    return { ...t, unary: this.#unaryAt.has(idx) }
  }

  // ---- 注释冲刷 ----------------------------------------------------------

  /** 冲刷 (through, idx) 之间的注释 */
  #flushCommentsBefore(idx: number): void {
    for (let i = this.#through + 1; i < idx; i++) {
      if (this.#tokens[i]!.type === 'comment') this.#flushComment(i)
    }
  }

  #flushComment(i: number): void {
    const c = this.#tokens[i]
    if (this.#prevReal !== null && this.#tokens[this.#prevReal].line === c.line) {
      // 行尾注释：留在当前行（懒换行尚未兑现 —— 注释属于上一行）
      const prevTok = this.#tokens[this.#prevReal]
      const gap = Math.max(1, c.col - (prevTok.col + prevTok.text.length))
      this.#out.appendTrailingComment(c.text, gap)
      this.#advanceCol(c.text, false)
      this.#through = i
      this.#lastEndLine = this.#m.endLine(i)
      this.#forceBreak = true
      return
    }
    // 独立注释：独占一行，缩进取下一行上下文（懒换行的目标缩进）
    if (this.#out.hasContent) this.#out.finishLine()
    if (this.#lastEndLine >= 0) {
      const blanks = c.line - this.#lastEndLine - 1
      if (blanks > 0) this.#out.addBlankLines(Math.min(2, blanks))
    }
    const cols = this.#lineIndent()
    this.#out.addStandaloneLine(cols, c.text)
    // addStandaloneLine 已把注释整行落入输出并另起空行 —— 当前行
    // 在 cols 列上重新开始（列跟踪不得沿用注释行的结束列）
    this.#col = cols
    this.#through = i
    this.#lastEndLine = this.#m.endLine(i)
  }

  // ==== 程序 ==============================================================

  run(p: Program): void {
    // module 头、每条 import、正文各占一行（语句级，同 def）
    const startStatement = () => {
      if (this.#out.hasContent && this.#pending === null) this.#newline(this.#lineIndent())
    }
    if (p.meta !== null) {
      this.#emitTo(p.meta.start)
      this.#printQuery(p.meta, this.#atCtx(0))
      this.#emitTo(p.imports[0]?.start ?? p.body?.start ?? p.end)
    }
    for (const imp of p.imports) {
      startStatement()
      this.#printImport(imp)
    }
    if (p.body !== null) {
      startStatement()
      this.#emitTo(p.body.start)
      this.#printQuery(p.body, this.#atCtx(0))
    }
    this.#emitTo(p.end)
    this.#flushTrailing()
    if (this.#rpos !== this.#real.length) {
      throw new Error(`internal: printer left ${this.#real.length - this.#rpos} token(s) unemitted`)
    }
  }

  #printImport(imp: ImportNode): void {
    this.#emitTo(imp.start)
    if (imp.meta !== null) {
      this.#emitTo(imp.meta.start)
      this.#printQuery(imp.meta, this.#atCtx(0))
    }
    this.#emitTo(imp.end)
  }

  // ==== 查询层 ============================================================

  #printQuery(q: Query, ctx: Ctx): void {
    switch (q.kind) {
      case 'pipe':
        this.#printPipe(q, ctx)
        return
      case 'comma':
        this.#printComma(q, ctx)
        return
      case 'as':
      case 'label':
        this.#printItemHead(q, ctx)
        return
      case 'expr':
        this.#printExpr(q.expr, ctx)
        return
    }
  }

  #printPipe(p: PipeNode, ctx: Ctx): void {
    this.#printQuery(p.segments[0]!.head, ctx)
    for (let i = 1; i < p.segments.length; i++) {
      const seg = p.segments[i]!
      const prev = p.segments[i - 1]!
      const bar = this.#m.prevReal(seg.start)!
      const broke = this.#m.brokeBetween(prev.end - 1, bar) || this.#m.brokeBetween(bar, seg.start)
      const fits =
        this.#effCol() + 3 + this.#m.firstLineWidth(seg.start, seg.end) <= this.#opts.printWidth
      if (broke || !fits) this.#newline(ctx.cont)
      this.#emitTo(seg.start) // '|'
      // 段内容在 '|' 之后：home＝cont＋1 层（段内括号组的锚点）
      this.#printQuery(seg.head, this.#segCtx(ctx.cont))
    }
  }

  /**
   * 裸逗号链（括号组内的逗号由组的元素循环接管，不走这里）。
   * 断行的逗号条目比逗号链深一层（纵向列表缩进一级），条目内部的
   * 链也随条目层 —— 否则 `| B, C` 里 C 与绑定 '|' 同列，层级消失
   */
  #printComma(c: CommaNode, ctx: Ctx): void {
    this.#printItem(c.items[0]!, ctx)
    for (let i = 1; i < c.items.length; i++) {
      const item = c.items[i]!
      const prev = c.items[i - 1]!
      const sep = this.#m.prevReal(item.start)!
      // 条目与分隔符之间有注释：分隔符已承接断行，条目跟在其后同行
      //（同 printGroup 的前导分隔符形态）
      const sepLed = this.#m.firstCommentBetween(prev.end, sep) !== undefined
      const broke = sepLed
        ? this.#m.brokeBetween(sep, item.start)
        : this.#m.brokeBetween(prev.end - 1, sep) || this.#m.brokeBetween(sep, item.start)
      const fits =
        this.#effCol() + 2 + this.#m.firstLineWidth(item.start, item.end) <= this.#opts.printWidth
      this.#emitTo(item.start) // ',' 尾随
      if (broke || !fits) this.#newline(ctx.cont + this.#is)
      this.#printItem(item, this.#lineCtx(ctx.cont + this.#is))
    }
  }

  /** 逗号条目：前导 def + head（as / label / expr） */
  #printItem(item: CommaItem, ctx: Ctx): void {
    // 条目基准缩进＝ctx.base（构造边界快照）。def 的排布与 def 之后的
    // head 都锚到这里 —— 不得在打印过程中回读行缩进（前一个 def 的体
    // 可能结束在更深一层的行上，会把后续兄弟内容带偏）
    const itemIndent = ctx.base
    for (const def of item.defs) {
      // def 前的断行按作者：源码在 def 之前断行才换行 ——「( def …」
      // 的悬挂形态由此保留。紧跟 '|' 的例外：管道已把尾随断行归一化
      // 为行首 '|'，def 与 '|' 已同行，不得二次断行
      const lastText = this.#prevReal !== null ? this.#tokens[this.#prevReal].text : null
      if (
        this.#prevReal !== null &&
        this.#out.hasContent &&
        this.#pending === null &&
        lastText !== '|' &&
        this.#m.brokeBetween(this.#prevReal, def.start)
      ) {
        this.#newline(itemIndent)
      }
      // def 的 home＝条目层级；其体在 def home＋1 层
      this.#printDef(def, this.#nestedCtx(itemIndent))
    }
    if (item.head === null) return
    if (item.defs.length > 0) {
      // def 之后的断行同样按作者：';' 之后源码断行才另起一行
      const lastDef = item.defs[item.defs.length - 1]!
      if (this.#m.brokeBetween(lastDef.end - 1, item.head.start)) this.#newline(itemIndent)
    }
    // head 是条目的内容（'; ' 不开新层）：home＝条目层级
    this.#printItemHead(item.head, { base: itemIndent, cont: ctx.cont })
  }

  #printItemHead(head: Query, ctx: Ctx): void {
    switch (head.kind) {
      case 'as': {
        const asIndent = ctx.base
        this.#printQuery(head.head, ctx)
        const asTok = this.#m.prevReal(head.patterns[0]!.start)!
        // 作者在 head 与 'as' 之间断行：'as' 以行首风格归一化到 cont
        if (this.#m.brokeBetween(head.head.end - 1, asTok)) this.#newline(ctx.cont)
        this.#emitTo(head.patterns[0]!.start) // 'as'
        // 作者在 'as' 之后断行：绑定模式另起一行，比 as 行深一层
        if (this.#m.brokeBetween(asTok, head.patterns[0]!.start)) this.#newline(asIndent + this.#is)
        for (let i = 0; i < head.patterns.length; i++) {
          // 模式是 'as ' 之后的内容：home＝as 层级＋1
          this.#printPattern(head.patterns[i]!, asIndent + this.#is)
          if (i + 1 < head.patterns.length) {
            // 作者在 '?//' 前后断行：分隔符尾随，备选模式另起一行
            const prevPat = head.patterns[i]!
            const next = head.patterns[i + 1]!
            const sep = this.#m.prevReal(next.start)! // '?//'
            this.#emitTo(next.start)
            if (
              this.#m.brokeBetween(prevPat.end - 1, sep) ||
              this.#m.brokeBetween(sep, next.start)
            ) {
              this.#newline(asIndent + this.#is)
            }
          }
        }
        // 作者在模式之后断行（'|' 前后任一侧）：行首 '|' 归一化到 cont
        const lastPat = head.patterns[head.patterns.length - 1]!
        const bar = this.#m.prevReal(head.body.start)!
        if (
          this.#m.brokeBetween(lastPat.end - 1, bar) ||
          this.#m.brokeBetween(bar, head.body.start)
        ) {
          this.#newline(ctx.cont)
        }
        this.#emitTo(head.body.start) // '|'
        this.#printQuery(head.body, this.#segCtx(ctx.cont))
        return
      }
      case 'label': {
        // label 的 '|' 与 as 的 '|' 同形：作者在 '$out' 与 '|' 之间或
        // '|' 之后断行时，'|' 以行首风格归一化到 cont
        const bar = this.#m.prevReal(head.body.start)!
        const varTok = this.#m.prevReal(bar)!
        if (this.#m.brokeBetween(varTok, bar) || this.#m.brokeBetween(bar, head.body.start)) {
          this.#emitTo(bar) // 'label $out'
          this.#newline(ctx.cont)
          this.#emitTo(head.body.start) // '|'
        } else {
          this.#emitTo(head.body.start) // label $out |
        }
        this.#printQuery(head.body, this.#segCtx(ctx.cont))
        return
      }
      default:
        this.#printExpr((head as Extract<Query, { kind: 'expr' }>).expr, ctx)
        return
    }
  }

  #printDef(def: FuncDefNode, ctx: Ctx): void {
    // def 的 home＝ctx.base（'def' 关键字所在层）；体在 home＋1 层
    const defIndent = ctx.base
    if (def.params !== null) {
      // 参数列表组：作者在参数边界断行时按 R2 展开
      this.#emitTo(def.params[0]!.start) // def name (
      this.#printGroup(
        this.#m.prevReal(def.params[0]!.start)!,
        this.#m.nextReal(def.params[def.params.length - 1]!.end)!,
        defIndent,
        def.params,
        (p) => this.#emitTo((p as { end: number }).end)
      )
      this.#emitTo(def.body.start) // ':'
    } else {
      this.#emitTo(def.body.start) // def name:
    }
    const colon = this.#m.prevReal(def.body.start)!
    const authorBroke = this.#m.brokeBetween(colon, def.body.start)
    const onLine =
      !authorBroke &&
      !this.#m.multiline(def.body) &&
      this.#effCol() + 1 + this.#m.flatWidth(def.body.start, def.body.end) + 1 <=
        this.#opts.printWidth
    if (!onLine) this.#newline(defIndent + this.#is)
    this.#printQuery(def.body, this.#atCtx(defIndent + this.#is))
    this.#emitTo(def.end) // ';'
  }

  // ==== 表达式层 ==========================================================

  #printExpr(e: Expr, ctx: Ctx): void {
    if (e.kind === 'chain') this.#printChain(e, ctx)
    else this.#printTerm(e.term, ctx)
  }

  /** R1 链：行首运算符，贪心填充 */
  #printChain(chain: Extract<Expr, { kind: 'chain' }>, ctx: Ctx): void {
    this.#printExpr(chain.first, ctx)
    let prev: Expr = chain.first
    for (const link of chain.links) {
      const brokeBefore = this.#m.brokeBetween(prev.end - 1, link.op)
      const brokeAfter = this.#m.brokeBetween(link.op, link.operand.start)
      const opText = this.#tokens[link.op].text
      const fits =
        this.#effCol() +
          1 +
          opText.length +
          1 +
          this.#m.firstLineWidth(link.operand.start, link.operand.end) <=
        this.#opts.printWidth
      // 仅一侧断行（含尾随风格）→ 归一化为行首运算符，操作数跟上；
      // 前后都断行 → 运算符独占一行（作者形态），操作数另起一行
      // （链 cont +1 层）
      if (brokeBefore || brokeAfter || !fits) this.#newline(ctx.cont)
      this.#emitTo(link.operand.start) // 运算符
      if (brokeBefore && brokeAfter) this.#newline(ctx.cont + this.#is)
      // 操作数是 'op ' 之后的内容：home＝cont＋1 层（其内部括号组与
      // 链的锚点；操作数另起一行时其行缩进即 cont＋1 层，同值）
      this.#printExpr(link.operand, this.#atCtx(ctx.cont + this.#is))
      prev = link.operand
    }
  }

  // ==== 词项层 ============================================================

  #printTerm(t: Term, ctx: Ctx): void {
    const innerEnd = t.suffixes.length > 0 ? t.suffixes[0]!.start : t.end
    this.#printTermInner(t, innerEnd, ctx)
    for (const s of t.suffixes) this.#printSuffix(s, ctx.base)
  }

  #printTermInner(t: Term, innerEnd: number, ctx: Ctx): void {
    const inner = t.inner
    switch (inner.kind) {
      case 'identity':
      case 'recurse':
      case 'field':
      case 'number':
      case 'string':
      case 'format':
      case 'break':
      case 'rawvar':
        this.#emitTo(innerEnd)
        return
      case 'func': {
        if (inner.args === null) {
          this.#emitTo(innerEnd)
          return
        }
        const open = this.#m.prevReal(inner.args[0]!.start)!
        this.#emitTo(open + 1) // name + '('
        // 唯一的对象/数组实参走「拥抱」：实参组自身不再套一层展开
        this.#printGroup(
          open,
          innerEnd - 1,
          ctx.base,
          inner.args,
          (a, c) => this.#printQuery(a as Query, c),
          true
        )
        return
      }
      case 'object': {
        this.#emitTo(t.start + 1) // '{'
        this.#printGroup(
          t.start,
          innerEnd - 1,
          ctx.base,
          inner.entries,
          (e, c) => this.#printObjectEntry(e as ObjectEntry, c),
          false,
          inner.trailingSep
        )
        return
      }
      case 'array': {
        if (inner.body === null) {
          this.#emitTo(innerEnd) // '[]'
          return
        }
        this.#emitTo(t.start + 1) // '['
        this.#printGroup(
          t.start,
          innerEnd - 1,
          ctx.base,
          this.#m.unwrapElements(inner.body),
          (el, c) => this.#printElement(el, c)
        )
        return
      }
      case 'paren': {
        this.#emitTo(t.start + 1) // '('
        this.#printGroup(
          t.start,
          innerEnd - 1,
          ctx.base,
          this.#m.unwrapElements(inner.body),
          (el, c) => this.#printElement(el, c)
        )
        return
      }
      case 'unary': {
        this.#emitTo(inner.operand.start) // '-' / '+'
        this.#printTerm(inner.operand, ctx)
        return
      }
      case 'if':
        this.#printIf(inner, innerEnd)
        return
      case 'try':
        this.#printTry(inner)
        return
      case 'reduce':
      case 'foreach': {
        const kwIndent = ctx.base
        const asTok = this.#m.prevReal(inner.pattern.start)!
        this.#emitTo(inner.src.start) // reduce / foreach
        // 作者在关键字之后断行：源表达式另起一行，比关键字行深一层；
        // 未断行时源表达式仍锚在关键字 home＋1 层
        if (this.#m.brokeBetween(t.start, inner.src.start)) this.#newline(kwIndent + this.#is)
        this.#printExpr(inner.src, this.#atCtx(kwIndent + this.#is))
        this.#emitTo(inner.pattern.start) // 'as'
        // 作者在 'as' 之后断行：绑定模式另起一行，比关键字行深一层；
        // 模式是 'as ' 之后的内容：home＝关键字 home＋1 层
        const asBroke = this.#m.brokeBetween(asTok, inner.pattern.start)
        if (asBroke) this.#newline(kwIndent + this.#is)
        this.#printPattern(inner.pattern, kwIndent + this.#is)
        // 作者在模式之后断行：分组另起一行，比关键字行深一层
        const groupBroke = this.#m.brokeBetween(inner.pattern.end - 1, inner.group.start)
        if (groupBroke) this.#newline(kwIndent + this.#is)
        this.#emitTo(inner.group.start + 1) // '('
        // 分组是 reduce 自身的组：基础缩进＝关键字 home（'(' 起行时
        // 为其行缩进，即 home＋1 层）
        this.#printGroup(
          inner.group.start,
          inner.group.end - 1,
          kwIndent + (asBroke || groupBroke ? this.#is : 0),
          inner.group.parts,
          (p, c) => this.#printQuery(p as Query, c)
        )
        return
      }
    }
  }

  #printSuffix(s: Suffix, base: number): void {
    switch (s.kind) {
      case 'field':
      case 'iter':
      case 'optional':
        this.#emitTo(s.end)
        return
      case 'index': {
        this.#emitTo(s.start + 1) // '['
        this.#printGroup(s.start, s.end - 1, base, [s.q], (q, c) => this.#printElement(q, c))
        return
      }
      case 'slice': {
        this.#emitTo(s.start + 1) // '['
        const children: Node[] = []
        if (s.from !== null) children.push(s.from)
        if (s.to !== null) children.push(s.to)
        this.#printGroup(s.start, s.end - 1, base, children, (el, c) => this.#printElement(el, c))
        return
      }
    }
  }

  /** 组元素：CommaItem（defs+head）或普通 Query */
  #printElement(el: Node, ctx: Ctx): void {
    if ('defs' in el) this.#printItem(el as CommaItem, ctx)
    else this.#printQuery(el as Query, ctx)
  }

  // ==== 尾随逗号（trailingComma 选项）=====================================

  /** 展开的非空对象：在闭括号排版前发射逗号，不能把闭括号的前导空格发给逗号。 */
  #finishObjectEntries(sourceComma: number | null | undefined): void {
    if (sourceComma === undefined) return // 非对象组
    if (this.#opts.trailingComma === 'multiline') {
      // 源码逗号已被统一抑制。无论源码是否有逗号，都走紧贴末条目的布局，
      // 先于该条目之后的注释发射，避免同一种布局两次格式化出现不同结果。
      this.#applyPending()
      this.#out.append(',', false)
      this.#advanceCol(',', false)
    } else if (this.#opts.trailingComma === 'preserve' && sourceComma !== null) {
      this.#emitTo(sourceComma + 1)
    }
  }

  // ==== 括号组（R2） ======================================================

  /**
   * 通用括号组：开括号已由调用方发射（留在当前行尾），这里负责展开
   * 判定与元素/闭括号发射。平铺组内的子结构由 fits 一致性保证也是
   * 平铺的，直接发射 token 即可。
   *
   * base＝拥有该组的构造的 home：展开式的元素在 base＋1 层、闭括号
   * 回 base（开括号起行时 base 即其行缩进；行中开括号时锚到构造的
   * home 而非所在行 —— `| eval_ast(` 的实参对齐段 home，不退回 '|'
   * 的行）。元素上下文按形态给出：悬挂首元素 home＝元素列、链对齐
   * 开括号列（行中开括号时 ≠ 行缩进，链若取行缩进会与外层链同列、
   * 层级消失）；其余元素的链随元素所在行。
   *
   * allowHug：调用实参组的「唯一对象/数组实参拥抱」—— 实参组自身
   * 不展开，开/闭括号贴着实参（实参按自己的规则展开）。作者在实参组
   * 自身层级断行（`map(\n{…})`）时不拥抱，按展开处理。
   */
  #printGroup(
    openIdx: number,
    closerIdx: number,
    base: number,
    children: Node[],
    printChild: (n: Node, ctx: Ctx) => void,
    allowHug = false,
    sourceComma?: number | null
  ): void {
    const authorBreak = this.#m.groupAuthorBreak(openIdx, closerIdx, children)
    const forced = this.#m.groupForced(openIdx, closerIdx, children)
    if (!forced) {
      // 条件③：开括号已落行，剩余内容（元素 + 闭括号）平铺放得下
      const rest = this.#m.flatWidth(openIdx + 1, closerIdx + 1)
      if (this.#col + rest <= this.#opts.printWidth) {
        this.#emitTo(closerIdx + 1)
        return
      }
    }
    // 拥抱：唯一的对象/数组实参（无后缀），组自身无作者断行/注释
    if (allowHug && !authorBreak && children.length === 1 && this.#isHuggable(children[0]!)) {
      printChild(children[0]!, this.#rowCtx())
      this.#emitTo(closerIdx + 1)
      return
    }
    // 悬挂式：作者把首元素写在开括号行上（其后未断行），且组内确有
    // 作者结构（断行/注释/结构性多行元素；纯超宽不算）—— 保留这个
    // 形态。后续元素竖向对齐到首元素所在列（开括号列 + 2：括号一列
    // ＋内侧补位一列）；闭括号回开括号列，调用式开括号（'f('，前一
    // token 是 ident）例外回行首
    const firstBroke = children.length > 0 && this.#m.brokeBetween(openIdx, children[0]!.start)
    if (forced && children.length > 0 && !firstBroke) {
      // 开括号列：本组自身的对齐锚点（开括号由调用方刚发射，col 即
      // 其结束列）
      const openerCol = this.#col - this.#tokens[openIdx]!.text.length
      const elemCol = openerCol + 2
      const prevTok = this.#m.prevReal(openIdx)
      const callLike = prevTok !== undefined && this.#tokens[prevTok].type === 'ident'
      // 悬挂组内侧补位：开括号后、贴行闭括号前各恰好一个空格
      this.#padNext = true
      for (let i = 0; i < children.length; i++) {
        if (i > 0) {
          const prev = children[i - 1]!
          const sep = this.#m.prevReal(children[i]!.start)!
          // 元素与分隔符之间有注释（行尾或独立）：分隔符已被注释推到
          // 新行，该处断行由分隔符承接 —— 元素跟在分隔符之后同行
          // （作者的前导分隔符形态），除非作者在分隔符之后另断
          const sepLed = this.#m.firstCommentBetween(prev.end, sep) !== undefined
          const broke = sepLed
            ? this.#m.brokeBetween(sep, children[i]!.start)
            : this.#m.brokeBetween(prev.end - 1, sep) ||
              this.#m.brokeBetween(sep, children[i]!.start)
          const fits =
            this.#effCol() + 1 + this.#m.firstLineWidth(children[i]!.start, children[i]!.end) <=
            this.#opts.printWidth
          if (broke || !fits) this.#newline(elemCol)
        }
        printChild(children[i]!, i === 0 ? this.#segCtx(openerCol) : this.#rowCtx())
        if (i + 1 < children.length) {
          // 行尾注释收尾的元素：分隔符无法尾随（注释之后不能附加
          // token），前导下一元素行、对齐开括号列；独立注释则留在其
          // 自然位置，分隔符与元素跟在其后
          const sep = this.#m.prevReal(children[i + 1]!.start)!
          const gap = this.#m.firstCommentBetween(children[i]!.end, sep)
          if (
            gap !== undefined &&
            this.#tokens[gap].line === this.#tokens[children[i]!.end - 1]!.line
          ) {
            this.#newline(openerCol)
          }
          this.#emitTo(children[i + 1]!.start) // 分隔符尾随
        }
      }
      // 尾随逗号（悬挂式是展开形态＝多行）
      this.#finishObjectEntries(sourceComma)
      // 闭括号：作者断行或注释在前 → 回开括号列（调用式回行首）；
      // 否则贴末元素（前补空格）
      const last = children[children.length - 1]!
      const closerBroke = this.#m.brokeBetween(last.end - 1, closerIdx)
      if (closerBroke || this.#m.hasCommentBefore(closerIdx, last.end)) {
        this.#newline(callLike ? base : openerCol)
      } else {
        this.#padNext = true
      }
      this.#emitTo(closerIdx + 1)
      return
    }
    // 分隔展开式：作者在开括号之后断行 —— 开括号独占行尾，每元素一行。
    // 元素是组的「段」：home＝base＋1 层，链对齐开括号层级（jqjq 语料
    // `_suffix` 的 '//' 交替链形态）
    let sepLedLine = false
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!
      // 分隔符已前导本元素行（前一元素以注释收尾）时不再另起
      if (!sepLedLine) this.#newline(base + this.#is)
      sepLedLine = false
      printChild(child, this.#segCtx(base))
      if (i + 1 < children.length) {
        const sep = this.#m.prevReal(children[i + 1]!.start)!
        const gap = this.#m.firstCommentBetween(child.end, sep)
        if (gap !== undefined) {
          // 元素以注释收尾：分隔符承接断行、前导下一元素行（行尾注释
          // 时对齐元素层，独立注释留在自然位置、分隔符随其后）
          if (this.#tokens[gap].line === this.#tokens[child.end - 1]!.line) {
            this.#newline(base + this.#is)
          }
          sepLedLine = true
        }
        this.#emitTo(children[i + 1]!.start) // 分隔符尾随
      }
    }
    if (children.length > 0) this.#finishObjectEntries(sourceComma)
    // 独立注释与闭括号在同一上下文，不受待抑制的源码逗号影响。
    this.#newline(base)
    this.#emitTo(closerIdx + 1) // 闭括号
  }

  /** 拥抱判定：查询是「裸的对象/数组词项」（无后缀链） */
  #isHuggable(n: Node): boolean {
    if (!('kind' in n) || (n as Query).kind !== 'expr') return false
    const term = (n as Extract<Query, { kind: 'expr' }>).expr
    if (term.kind !== 'term') return false
    return (
      term.term.suffixes.length === 0 &&
      (term.term.inner.kind === 'object' || term.term.inner.kind === 'array')
    )
  }

  // ==== 对象条目（R3）=====================================================

  #printObjectEntry(e: ObjectEntry, ctx: Ctx): void {
    if (e.value === null) {
      this.#emitTo(e.end) // 简写键
      return
    }
    const entryIndent = ctx.base
    this.#printKey(e.key, e.value.start, ctx)
    this.#emitTo(e.value.start) // ':'
    // 值是 'key: ' 之后的内容：未断行时 home＝条目层级（续行随条目
    // 层）；作者在冒号之后断行时值另起一行（条目＋1 层）—— jqjq 语料
    // 39 处冒号断行全部如此，续行也随该层
    const colon = this.#m.prevReal(e.value.start)!
    const broke = this.#m.brokeBetween(colon, e.value.start)
    if (broke) this.#newline(entryIndent + this.#is)
    this.#printQuery(e.value, this.#atCtx(broke ? entryIndent + this.#is : entryIndent))
  }

  #printKey(key: ObjectKey, bound: number, ctx: Ctx): void {
    if (key.kind === 'query') {
      this.#emitTo(key.q.start) // '('
      this.#printQuery(key.q, this.#nestedCtx(ctx.base))
      this.#emitTo(bound) // '):'
      return
    }
    this.#emitTo(bound)
  }

  // ==== if（R4）==========================================================

  #printIf(inner: Extract<TermInner, { kind: 'if' }>, innerEnd: number): void {
    const first = inner.clauses[0]!
    this.#emitTo(first.cond.start) // 'if'
    // 子句锚点取 if 关键字所在列（而非行缩进）：if 处于悬挂组首元素、
    // 行中前缀（'| '、'key: ' 等）之后时，then/elif/else/end 与 if
    // 竖向对齐；if 起行时两者相等。这是本构造自身的对齐锚点（col 的
    // 合法用途），不是层级推导
    const ifIndent = this.#col - 'if'.length
    const ifTok = this.#m.prevReal(first.cond.start)!
    if (this.#m.brokeBetween(ifTok, first.cond.start)) this.#newline(ifIndent + this.#is)
    this.#printQuery(first.cond, this.#atCtx(ifIndent + this.#is))

    let prevEnd = first.cond.end
    for (let ci = 0; ci < inner.clauses.length; ci++) {
      const clause = inner.clauses[ci]!
      if (ci > 0) {
        // elif：只在作者断行或关键字自身放不下时换行；条件另起由作者断行决定
        const elifTok = this.#m.nextReal(prevEnd)!
        const broke = this.#m.brokeBetween(prevEnd - 1, elifTok)
        const kwFits = this.#effCol() + 1 + 4 <= this.#opts.printWidth
        if (broke || !kwFits) this.#newline(ifIndent)
        this.#emitTo(clause.cond.start) // 'elif'
        if (this.#m.brokeBetween(elifTok, clause.cond.start)) this.#newline(ifIndent + this.#is)
        this.#printQuery(clause.cond, this.#atCtx(ifIndent + this.#is))
        prevEnd = clause.cond.end
      }
      const thenTok = this.#m.nextReal(clause.cond.end)!
      this.#printClauseKeyword(clause.then, thenTok, ifIndent)
      prevEnd = clause.then.end
    }
    if (inner.elseQ !== null) {
      const elseTok = this.#m.nextReal(prevEnd)!
      this.#printClauseKeyword(inner.elseQ, elseTok, ifIndent)
      prevEnd = inner.elseQ.end
    }
    const endTok = innerEnd - 1
    const endBroke = this.#m.brokeBetween(prevEnd - 1, endTok)
    const endFits = this.#effCol() + 1 + 'end'.length <= this.#opts.printWidth
    if (endBroke || !endFits) this.#newline(ifIndent)
    this.#emitTo(innerEnd) // 'end'
  }

  /**
   * then/else 子句：关键字只在作者断行或自身放不下时换行（回 if 缩进）；
   * 体放得下且非结构性多行时留在关键字行，否则另起一行（if 缩进 +1 层）
   */
  #printClauseKeyword(body: Query, kwTok: number, ifIndent: number): void {
    const kwText = this.#tokens[kwTok].text
    const prevTok = this.#m.prevReal(kwTok)!
    const broke = this.#m.brokeBetween(prevTok, kwTok)
    const kwFits = this.#effCol() + 1 + kwText.length <= this.#opts.printWidth
    if (broke || !kwFits) this.#newline(ifIndent)
    this.#emitTo(body.start) // then / else
    const authorBroke = this.#m.brokeBetween(kwTok, body.start)
    const onLine =
      !authorBroke &&
      !this.#m.multiline(body) &&
      this.#effCol() + 1 + this.#m.flatWidth(body.start, body.end) <= this.#opts.printWidth
    if (!onLine) this.#newline(ifIndent + this.#is)
    this.#printQuery(body, this.#atCtx(ifIndent + this.#is))
  }

  // ==== try（R5）=========================================================

  #printTry(inner: Extract<TermInner, { kind: 'try' }>): void {
    const tryTok = this.#m.prevReal(inner.body.start)!
    this.#emitTo(inner.body.start) // 'try'
    // 同 if：catch 与 try 关键字所在列对齐（本构造自身的锚点）
    const tryIndent = this.#col - 'try'.length
    if (this.#m.brokeBetween(tryTok, inner.body.start)) this.#newline(tryIndent + this.#is)
    this.#printExpr(inner.body, this.#atCtx(tryIndent + this.#is))
    if (inner.catchBody === null) return
    const catchTok = this.#m.nextReal(inner.body.end)!
    const broke = this.#m.brokeBetween(inner.body.end - 1, catchTok)
    const kwFits = this.#effCol() + 1 + 'catch'.length <= this.#opts.printWidth
    if (broke || !kwFits) this.#newline(tryIndent)
    this.#emitTo(inner.catchBody.start) // 'catch'
    const authorBroke = this.#m.brokeBetween(catchTok, inner.catchBody.start)
    const onLine =
      !authorBroke &&
      !this.#m.multiline(inner.catchBody) &&
      this.#effCol() + 1 + this.#m.flatWidth(inner.catchBody.start, inner.catchBody.end) <=
        this.#opts.printWidth
    if (!onLine) this.#newline(tryIndent + this.#is)
    this.#printExpr(inner.catchBody, this.#atCtx(tryIndent + this.#is))
  }

  // ==== 析构模式 ==========================================================

  #printPattern(p: PatternNode, home: number): void {
    switch (p.kind) {
      case 'pvar':
        this.#emitTo(p.end)
        return
      case 'parray':
        this.#emitTo(p.start + 1) // '['
        this.#printGroup(p.start, p.end - 1, home, p.items, (it, c) =>
          this.#printPattern(it as PatternNode, c.base)
        )
        return
      case 'pobject':
        this.#emitTo(p.start + 1) // '{'
        this.#printGroup(p.start, p.end - 1, home, p.entries, (e, c) =>
          this.#printPatternEntry(e as PatternEntry, c)
        )
        return
    }
  }

  #printPatternEntry(e: PatternEntry, ctx: Ctx): void {
    if (e.value === null) {
      this.#emitTo(e.end) // $var 简写
      return
    }
    this.#printKey(e.key, e.value.start, ctx)
    this.#emitTo(e.value.start) // ':'
    // 与对象条目同形：未断行时值模式随条目层；作者在冒号之后断行时
    // 另起一行（条目＋1 层）
    const colon = this.#m.prevReal(e.value.start)!
    const broke = this.#m.brokeBetween(colon, e.value.start)
    if (broke) this.#newline(ctx.base + this.#is)
    this.#printPattern(e.value, broke ? ctx.base + this.#is : ctx.base)
  }
}
