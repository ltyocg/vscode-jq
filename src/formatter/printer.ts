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
 *  - 断行决策只依赖源码换行（作者意图）与当前列的行宽（贪心），
 *    缩进一律取 indentSize 整数倍，不做锚点列对齐。
 *  - 从不改动 token 文本，从不增删 token。
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

export function printProgramResult(r: ParseResult, opts: FormatOptions): string {
  const out = new LineBuilder()
  const metrics = new Metrics(r.tokens, r.real, r.unaryAt, opts.printWidth)
  new Printer(r.tokens, r.real, r.unaryAt, opts, out, metrics).run(r.program)
  // 最后一行内容仍在拼行缓冲里，先落行再收尾（空行由 trim 去掉）
  out.finishLine()
  out.trimTrailingBlankLines()
  return out.join('\n')
}

class Printer {
  /** 实 token 游标（real 数组下标） */
  private rpos = 0
  /** 已发射/已冲刷的最末 token 原始下标 */
  private through = -1
  private prevReal: number | null = null
  private lastEndLine = -1
  /** 行尾注释之后强制换行 */
  private forceBreak = false
  /** 悬挂组内侧补位：下一个实 token 之前补一个空格（开括号后/贴行闭括号前） */
  private padNext = false
  /** 懒换行：意图中的下一行缩进 */
  private pending: number | null = null
  /** 当前行已写到的列（多行 token 之后 = 其末行内容宽度） */
  private col = 0
  /** 与发射同步的括号栈（gapBetween 的 enclosing） */
  private stack: string[] = []

  constructor(
    private readonly tokens: Token[],
    private readonly real: number[],
    private readonly unaryAt: Set<number>,
    private readonly opts: FormatOptions,
    private readonly out: LineBuilder,
    private readonly m: Metrics
  ) {}

  private get is(): number {
    return this.opts.indentSize
  }

  // ==== 游标与发射 ========================================================

  /** 当前行的有效缩进（含未兑现的懒换行） */
  private lineIndent(): number {
    return this.pending ?? this.out.indentCols
  }

  /** 下一段内容若不断行将落到的列 */
  private effCol(): number {
    return this.pending !== null ? this.pending : this.col
  }

  /**
   * 悬挂组首元素的链锚点：开括号列（行中开括号时 ≠ 行缩进，链若取行
   * 缩进会与外层链同列、层级消失）。仅悬挂分支为首元素设置；嵌套组
   * 在自身入口清零、出口恢复，不会泄漏到更深的内容
   */
  private hangChainCont: number | null = null

  /** 组元素的链 cont：悬挂首元素对齐开括号列，其余取当前行缩进 */
  private elemCont(): number {
    return this.hangChainCont ?? this.lineIndent()
  }

  private newline(cols: number): void {
    this.pending = cols
  }

  private applyPending(): void {
    if (this.pending === null) return
    if (this.out.hasContent) this.out.finishLine()
    this.out.startLine(this.pending)
    this.col = this.pending
    this.pending = null
  }

  /** 发射 [pos, to) 的全部实 token：每个 token 前冲刷途经注释 */
  private emitTo(to: number): void {
    while (this.rpos < this.real.length && this.real[this.rpos] < to) {
      const idx = this.real[this.rpos]
      this.flushCommentsBefore(idx)
      this.emitReal(idx)
      this.rpos++
    }
  }

  /** 发射文件尾部残余注释（最后一个实 token 之后的） */
  private flushTrailing(): void {
    for (let i = this.through + 1; i < this.tokens.length; i++) {
      if (this.tokens[i]!.type === 'comment') this.flushComment(i)
    }
  }

  private emitReal(idx: number): void {
    const tk = this.tokens[idx]
    // 行尾注释之后的强制换行（懒换行兑现；已有断行意图则不覆盖）
    if (this.forceBreak) {
      this.forceBreak = false
      if (this.out.hasContent && this.pending === null) this.newline(this.lineIndent())
    }
    this.applyPending()
    // 空行保持（新行首才有可能；lastEndLine ≥ 0 才有「上文」）
    if (!this.out.hasContent && this.lastEndLine >= 0) {
      const blanks = tk.line - this.lastEndLine - 1
      if (blanks > 0) this.out.addBlankLines(Math.min(2, blanks))
    }
    const enclosing = this.stack.length > 0 ? this.stack[this.stack.length - 1]! : ''
    const prev = this.prevReal !== null ? this.toFmt(this.prevReal) : undefined
    const pad = this.padNext
    this.padNext = false
    const space =
      prev !== undefined &&
      this.out.hasContent &&
      (gapBetween(prev, this.toFmt(idx), enclosing) === 'space' || pad)
    this.out.append(tk.text, space)
    this.advanceCol(tk.text, space)
    // 括号栈同步（发射之后：闭括号弹出自己那层，开括号压入）
    if (tk.type === 'operator') {
      if (tk.text === '(' || tk.text === '[' || tk.text === '{') this.stack.push(tk.text)
      else if (tk.text === ')' || tk.text === ']' || tk.text === '}') this.stack.pop()
    }
    this.prevReal = idx
    this.through = idx
    this.lastEndLine = this.m.endLine(idx)
  }

  /** 发射后推进列（多行 token：取末行内容宽度） */
  private advanceCol(text: string, space: boolean): void {
    const nl = text.lastIndexOf('\n')
    if (nl >= 0) this.col = text.length - nl - 1
    else this.col += (space ? 1 : 0) + text.length
  }

  private toFmt(idx: number) {
    const t = this.tokens[idx]
    return { ...t, unary: this.unaryAt.has(idx) }
  }

  // ---- 注释冲刷 ----------------------------------------------------------

  /** 冲刷 (through, idx) 之间的注释 */
  private flushCommentsBefore(idx: number): void {
    for (let i = this.through + 1; i < idx; i++) {
      if (this.tokens[i]!.type === 'comment') this.flushComment(i)
    }
  }

  private flushComment(i: number): void {
    const c = this.tokens[i]
    if (this.prevReal !== null && this.tokens[this.prevReal].line === c.line) {
      // 行尾注释：留在当前行（懒换行尚未兑现 —— 注释属于上一行）
      const prevTok = this.tokens[this.prevReal]
      const gap = Math.max(1, c.col - (prevTok.col + prevTok.text.length))
      this.out.appendTrailingComment(c.text, gap)
      this.advanceCol(c.text, false)
      this.through = i
      this.lastEndLine = this.m.endLine(i)
      this.forceBreak = true
      return
    }
    // 独立注释：独占一行，缩进取下一行上下文（懒换行的目标缩进）
    if (this.out.hasContent) this.out.finishLine()
    if (this.lastEndLine >= 0) {
      const blanks = c.line - this.lastEndLine - 1
      if (blanks > 0) this.out.addBlankLines(Math.min(2, blanks))
    }
    const cols = this.pending ?? this.out.indentCols
    this.out.addStandaloneLine(cols, c.text)
    // addStandaloneLine 已把注释整行落入输出并另起空行 —— 当前行
    // 在 cols 列上重新开始（列跟踪不得沿用注释行的结束列）
    this.col = cols
    this.through = i
    this.lastEndLine = this.m.endLine(i)
  }

  // ==== 程序 ==============================================================

  run(p: Program): void {
    // module 头、每条 import、正文各占一行（语句级，同 def）
    const startStatement = () => {
      if (this.out.hasContent && this.pending === null) this.newline(this.lineIndent())
    }
    if (p.meta !== null) {
      this.emitTo(p.meta.start)
      this.printQuery(p.meta, 0)
      this.emitTo(p.imports[0]?.start ?? p.body?.start ?? p.end)
    }
    for (const imp of p.imports) {
      startStatement()
      this.printImport(imp)
    }
    if (p.body !== null) {
      startStatement()
      this.emitTo(p.body.start)
      this.printQuery(p.body, 0)
    }
    this.emitTo(p.end)
    this.flushTrailing()
    if (this.rpos !== this.real.length) {
      throw new Error(`internal: printer left ${this.real.length - this.rpos} token(s) unemitted`)
    }
  }

  private printImport(imp: ImportNode): void {
    this.emitTo(imp.start)
    if (imp.meta !== null) {
      this.emitTo(imp.meta.start)
      this.printQuery(imp.meta, 0)
    }
    this.emitTo(imp.end)
  }

  // ==== 查询层 ============================================================

  private printQuery(q: Query, cont: number): void {
    switch (q.kind) {
      case 'pipe':
        this.printPipe(q, cont)
        return
      case 'comma':
        this.printComma(q, cont)
        return
      case 'as':
      case 'label':
        this.printItemHead(q, cont)
        return
      case 'expr':
        this.printExpr(q.expr, cont)
        return
    }
  }

  private printPipe(p: PipeNode, cont: number): void {
    this.printQuery(p.segments[0]!.head, cont)
    for (let i = 1; i < p.segments.length; i++) {
      const seg = p.segments[i]!
      const prev = p.segments[i - 1]!
      const bar = this.m.prevReal(seg.start)!
      const broke = this.m.brokeBetween(prev.end - 1, bar) || this.m.brokeBetween(bar, seg.start)
      const fits = this.effCol() + 3 + this.m.flatWidth(seg.start, seg.end) <= this.opts.printWidth
      if (broke || !fits) this.newline(cont)
      this.emitTo(seg.start) // '|'
      this.printQuery(seg.head, cont)
    }
  }

  /**
   * 裸逗号链（括号组内的逗号由组的元素循环接管，不走这里）。
   * 断行的逗号条目比逗号链深一层（纵向列表缩进一级），条目内部的
   * 链也随条目层 —— 否则 `| B, C` 里 C 与绑定 '|' 同列，层级消失
   */
  private printComma(c: CommaNode, cont: number): void {
    this.printItem(c.items[0]!, cont)
    for (let i = 1; i < c.items.length; i++) {
      const item = c.items[i]!
      const prev = c.items[i - 1]!
      const sep = this.m.prevReal(item.start)!
      const broke = this.m.brokeBetween(prev.end - 1, sep) || this.m.brokeBetween(sep, item.start)
      const fits =
        this.effCol() + 2 + this.m.flatWidth(item.start, item.end) <= this.opts.printWidth
      this.emitTo(item.start) // ',' 尾随
      if (broke || !fits) this.newline(cont + this.is)
      this.printItem(item, cont + this.is)
    }
  }

  /** 逗号条目：前导 def + head（as / label / expr） */
  private printItem(item: CommaItem, cont: number): void {
    // 条目基准缩进：在入口捕获。def 的排布与 def 之后的 head 都锚到
    // 这里 —— 不得用打印过程中演化的 lineIndent()（前一个 def 的体
    // 可能结束在更深一层的行上，会把后续兄弟内容带偏）
    const itemIndent = this.lineIndent()
    for (const def of item.defs) {
      // def 前的断行按作者：源码在 def 之前断行才换行 ——「( def …」
      // 的悬挂形态由此保留。紧跟 '|' 的例外：管道已把尾随断行归一化
      // 为行首 '|'，def 与 '|' 已同行，不得二次断行
      const lastText = this.prevReal !== null ? this.tokens[this.prevReal].text : null
      if (
        this.prevReal !== null &&
        this.out.hasContent &&
        this.pending === null &&
        lastText !== '|' &&
        this.m.brokeBetween(this.prevReal, def.start)
      ) {
        this.newline(itemIndent)
      }
      this.printDef(def)
    }
    if (item.head === null) return
    if (item.defs.length > 0) {
      // def 之后的断行同样按作者：';' 之后源码断行才另起一行
      const lastDef = item.defs[item.defs.length - 1]!
      if (this.m.brokeBetween(lastDef.end - 1, item.head.start)) this.newline(itemIndent)
    }
    this.printItemHead(item.head, cont)
  }

  private printItemHead(head: Query, cont: number): void {
    switch (head.kind) {
      case 'as': {
        const asIndent = this.lineIndent()
        this.printQuery(head.head, cont)
        const asTok = this.m.prevReal(head.patterns[0]!.start)!
        // 作者在 head 与 'as' 之间断行：'as' 以行首风格归一化到 cont
        if (this.m.brokeBetween(head.head.end - 1, asTok)) this.newline(cont)
        this.emitTo(head.patterns[0]!.start) // 'as'
        // 作者在 'as' 之后断行：绑定模式另起一行，比 as 行深一层
        if (this.m.brokeBetween(asTok, head.patterns[0]!.start)) this.newline(asIndent + this.is)
        for (let i = 0; i < head.patterns.length; i++) {
          this.printPattern(head.patterns[i]!)
          if (i + 1 < head.patterns.length) {
            // 作者在 '?//' 前后断行：分隔符尾随，备选模式另起一行
            const prevPat = head.patterns[i]!
            const next = head.patterns[i + 1]!
            const sep = this.m.prevReal(next.start)! // '?//'
            this.emitTo(next.start)
            if (this.m.brokeBetween(prevPat.end - 1, sep) || this.m.brokeBetween(sep, next.start)) {
              this.newline(asIndent + this.is)
            }
          }
        }
        // 作者在模式之后断行（'|' 前后任一侧）：行首 '|' 归一化到 cont
        const lastPat = head.patterns[head.patterns.length - 1]!
        const bar = this.m.prevReal(head.body.start)!
        if (
          this.m.brokeBetween(lastPat.end - 1, bar) ||
          this.m.brokeBetween(bar, head.body.start)
        ) {
          this.newline(cont)
        }
        this.emitTo(head.body.start) // '|'
        this.printQuery(head.body, cont)
        return
      }
      case 'label': {
        // label 的 '|' 与 as 的 '|' 同形：作者在 '$out' 与 '|' 之间或
        // '|' 之后断行时，'|' 以行首风格归一化到 cont
        const bar = this.m.prevReal(head.body.start)!
        const varTok = this.m.prevReal(bar)!
        if (this.m.brokeBetween(varTok, bar) || this.m.brokeBetween(bar, head.body.start)) {
          this.emitTo(bar) // 'label $out'
          this.newline(cont)
          this.emitTo(head.body.start) // '|'
        } else {
          this.emitTo(head.body.start) // label $out |
        }
        this.printQuery(head.body, cont)
        return
      }
      default:
        this.printExpr((head as Extract<Query, { kind: 'expr' }>).expr, cont)
        return
    }
  }

  private printDef(def: FuncDefNode): void {
    const defIndent = this.lineIndent()
    if (def.params !== null) {
      // 参数列表组：作者在参数边界断行时按 R2 展开
      this.emitTo(def.params[0]!.start) // def name (
      this.printGroup(
        this.m.prevReal(def.params[0]!.start)!,
        this.m.nextReal(def.params[def.params.length - 1]!.end)!,
        def.params,
        (p) => this.emitTo((p as { end: number }).end)
      )
      this.emitTo(def.body.start) // ':'
    } else {
      this.emitTo(def.body.start) // def name:
    }
    const colon = this.m.prevReal(def.body.start)!
    const authorBroke = this.m.brokeBetween(colon, def.body.start)
    const onLine =
      !authorBroke &&
      !this.m.multiline(def.body) &&
      this.effCol() + 1 + this.m.flatWidth(def.body.start, def.body.end) + 1 <= this.opts.printWidth
    if (!onLine) this.newline(defIndent + this.is)
    this.printQuery(def.body, defIndent + this.is)
    this.emitTo(def.end) // ';'
  }

  // ==== 表达式层 ==========================================================

  private printExpr(e: Expr, cont: number): void {
    if (e.kind === 'chain') this.printChain(e, cont)
    else this.printTerm(e.term, cont)
  }

  /** R1 链：行首运算符，贪心填充 */
  private printChain(chain: Extract<Expr, { kind: 'chain' }>, cont: number): void {
    this.printExpr(chain.first, cont)
    let prev: Expr = chain.first
    for (const link of chain.links) {
      const brokeBefore = this.m.brokeBetween(prev.end - 1, link.op)
      const brokeAfter = this.m.brokeBetween(link.op, link.operand.start)
      const opText = this.tokens[link.op].text
      const fits =
        this.effCol() +
          1 +
          opText.length +
          1 +
          this.m.flatWidth(link.operand.start, link.operand.end) <=
        this.opts.printWidth
      // 仅一侧断行（含尾随风格）→ 归一化为行首运算符，操作数跟上；
      // 前后都断行 → 运算符独占一行（作者形态），操作数另起一行
      // （链 cont +1 层）
      if (brokeBefore || brokeAfter || !fits) this.newline(cont)
      this.emitTo(link.operand.start) // 运算符
      if (brokeBefore && brokeAfter) this.newline(cont + this.is)
      // 操作数内部的链比本层深一级（前缀 `op ` 存在；操作数另起一行时
      // 其行缩进即 cont +1 层，同值）
      this.printExpr(link.operand, this.lineIndent() + this.is)
      prev = link.operand
    }
  }

  // ==== 词项层 ============================================================

  private printTerm(t: Term, cont: number): void {
    const innerEnd = t.suffixes.length > 0 ? t.suffixes[0]!.start : t.end
    this.printTermInner(t, innerEnd, cont)
    for (const s of t.suffixes) this.printSuffix(s)
  }

  private printTermInner(t: Term, innerEnd: number, cont: number): void {
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
        this.emitTo(innerEnd)
        return
      case 'func': {
        if (inner.args === null) {
          this.emitTo(innerEnd)
          return
        }
        const open = this.m.prevReal(inner.args[0]!.start)!
        this.emitTo(open + 1) // name + '('
        // 唯一的对象/数组实参走「拥抱」：实参组自身不再套一层展开
        this.printGroup(
          open,
          innerEnd - 1,
          inner.args,
          (a) => this.printQuery(a as Query, this.elemCont()),
          true
        )
        return
      }
      case 'object': {
        this.emitTo(t.start + 1) // '{'
        this.printGroup(t.start, innerEnd - 1, inner.entries, (e) =>
          this.printObjectEntry(e as ObjectEntry)
        )
        return
      }
      case 'array': {
        if (inner.body === null) {
          this.emitTo(innerEnd) // '[]'
          return
        }
        this.emitTo(t.start + 1) // '['
        this.printGroup(t.start, innerEnd - 1, this.m.unwrapElements(inner.body), (el) =>
          this.printElement(el)
        )
        return
      }
      case 'paren': {
        this.emitTo(t.start + 1) // '('
        this.printGroup(t.start, innerEnd - 1, this.m.unwrapElements(inner.body), (el) =>
          this.printElement(el)
        )
        return
      }
      case 'unary': {
        this.emitTo(inner.operand.start) // '-' / '+'
        this.printTerm(inner.operand, cont)
        return
      }
      case 'if':
        this.printIf(inner, innerEnd)
        return
      case 'try':
        this.printTry(inner)
        return
      case 'reduce':
      case 'foreach': {
        const kwIndent = this.lineIndent()
        const asTok = this.m.prevReal(inner.pattern.start)!
        this.emitTo(inner.src.start) // reduce / foreach
        // 作者在关键字之后断行：源表达式另起一行，比关键字行深一层
        if (this.m.brokeBetween(t.start, inner.src.start)) this.newline(kwIndent + this.is)
        this.printExpr(inner.src, kwIndent + this.is)
        this.emitTo(inner.pattern.start) // 'as'
        // 作者在 'as' 之后断行：绑定模式另起一行，比关键字行深一层
        if (this.m.brokeBetween(asTok, inner.pattern.start)) this.newline(kwIndent + this.is)
        this.printPattern(inner.pattern)
        // 作者在模式之后断行：分组另起一行，比关键字行深一层
        if (this.m.brokeBetween(inner.pattern.end - 1, inner.group.start)) {
          this.newline(kwIndent + this.is)
        }
        this.emitTo(inner.group.start + 1) // '('
        this.printGroup(inner.group.start, inner.group.end - 1, inner.group.parts, (p) =>
          this.printQuery(p as Query, this.elemCont())
        )
        return
      }
    }
  }

  private printSuffix(s: Suffix): void {
    switch (s.kind) {
      case 'field':
      case 'iter':
      case 'optional':
        this.emitTo(s.end)
        return
      case 'index': {
        this.emitTo(s.start + 1) // '['
        this.printGroup(s.start, s.end - 1, [s.q], (q) => this.printElement(q))
        return
      }
      case 'slice': {
        this.emitTo(s.start + 1) // '['
        const children: Node[] = []
        if (s.from !== null) children.push(s.from)
        if (s.to !== null) children.push(s.to)
        this.printGroup(s.start, s.end - 1, children, (c) => this.printElement(c))
        return
      }
    }
  }

  /** 组元素：CommaItem（defs+head）或普通 Query */
  private printElement(el: Node): void {
    if ('defs' in el) this.printItem(el as CommaItem, this.elemCont())
    else this.printQuery(el as Query, this.elemCont())
  }

  // ==== 括号组（R2） ======================================================

  /**
   * 通用括号组：开括号已由调用方发射（留在当前行尾），这里负责展开
   * 判定与元素/闭括号发射。平铺组内的子结构由 fits 一致性保证也是
   * 平铺的，直接发射 token 即可。
   *
   * allowHug：调用实参组的「唯一对象/数组实参拥抱」—— 实参组自身
   * 不展开，开/闭括号贴着实参（实参按自己的规则展开）。作者在实参组
   * 自身层级断行（`map(\n{…})`）时不拥抱，按展开处理。
   */
  private printGroup(
    openIdx: number,
    closerIdx: number,
    children: Node[],
    printChild: (n: Node) => void,
    allowHug = false
  ): void {
    // 悬挂链锚点作用域：嵌套组内不继承外层的首元素锚点，退出时恢复
    const savedChainCont = this.hangChainCont
    this.hangChainCont = null
    const authorBreak = this.m.groupAuthorBreak(openIdx, closerIdx, children)
    const forced = this.m.groupForced(openIdx, closerIdx, children)
    if (!forced) {
      // 条件③：开括号已落行，剩余内容（元素 + 闭括号）平铺放得下
      const rest = this.m.flatWidth(openIdx + 1, closerIdx + 1)
      if (this.col + rest <= this.opts.printWidth) {
        this.emitTo(closerIdx + 1)
        this.hangChainCont = savedChainCont
        return
      }
    }
    // 拥抱：唯一的对象/数组实参（无后缀），组自身无作者断行/注释
    if (allowHug && !authorBreak && children.length === 1 && this.isHuggable(children[0]!)) {
      printChild(children[0]!)
      this.emitTo(closerIdx + 1)
      this.hangChainCont = savedChainCont
      return
    }
    const base = this.out.indentCols
    // 悬挂式：作者把首元素写在开括号行上（其后未断行），且组内确有
    // 作者结构（断行/注释/结构性多行元素；纯超宽不算）—— 保留这个
    // 形态。首元素的链对齐开括号列；后续元素竖向对齐到首元素所在列
    // （开括号列 + 2：括号一列＋内侧补位一列）；闭括号回开括号列，
    // 调用式开括号（'f('，前一 token 是 ident）例外回行首
    const firstBroke = children.length > 0 && this.m.brokeBetween(openIdx, children[0]!.start)
    if (forced && children.length > 0 && !firstBroke) {
      const openerCol = this.col - this.tokens[openIdx]!.text.length
      const elemCol = openerCol + 2
      const prevTok = this.m.prevReal(openIdx)
      const callLike = prevTok !== undefined && this.tokens[prevTok].type === 'ident'
      // 悬挂组内侧补位：开括号后、贴行闭括号前各恰好一个空格
      this.padNext = true
      for (let i = 0; i < children.length; i++) {
        if (i > 0) {
          const prev = children[i - 1]!
          const sep = this.m.prevReal(children[i]!.start)!
          const broke =
            this.m.brokeBetween(prev.end - 1, sep) || this.m.brokeBetween(sep, children[i]!.start)
          const fits =
            this.effCol() + 1 + this.m.flatWidth(children[i]!.start, children[i]!.end) <=
            this.opts.printWidth
          if (broke || !fits) this.newline(elemCol)
        }
        this.hangChainCont = i === 0 ? openerCol : null
        printChild(children[i]!)
        this.hangChainCont = null
        if (i + 1 < children.length) this.emitTo(children[i + 1]!.start) // 分隔符尾随
      }
      // 闭括号：作者断行或注释在前 → 回开括号列（调用式回行首）；
      // 否则贴末元素（前补空格）
      const last = children[children.length - 1]!
      const closerBroke = this.m.brokeBetween(last.end - 1, closerIdx)
      if (closerBroke || this.m.hasCommentBefore(closerIdx, last.end)) {
        if (this.m.hasCommentBefore(closerIdx, last.end)) this.newline(elemCol)
        this.emitTo(closerIdx) // 冲刷闭括号前的注释
        this.newline(callLike ? base : openerCol)
      } else {
        this.padNext = true
      }
      this.emitTo(closerIdx + 1)
      this.hangChainCont = savedChainCont
      return
    }
    // 分隔展开式：作者在开括号之后断行 —— 开括号独占行尾，每元素一行
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!
      this.newline(base + this.is)
      printChild(child)
      if (i + 1 < children.length) this.emitTo(children[i + 1]!.start) // 分隔符尾随
    }
    // 闭括号前的注释对齐到元素层（无元素时空组注释也在此层）
    const lastEnd = children.length > 0 ? children[children.length - 1]!.end : openIdx + 1
    if (this.m.hasCommentBefore(closerIdx, lastEnd)) {
      if (children.length === 0 || this.out.hasContent) this.newline(base + this.is)
    }
    this.emitTo(closerIdx) // 冲刷闭括号前的注释与残余分隔符
    this.newline(base)
    this.emitTo(closerIdx + 1) // 闭括号
    this.hangChainCont = savedChainCont
  }

  /** 拥抱判定：查询是「裸的对象/数组词项」（无后缀链） */
  private isHuggable(n: Node): boolean {
    if (!('kind' in n) || (n as Query).kind !== 'expr') return false
    const term = (n as Extract<Query, { kind: 'expr' }>).expr
    if (term.kind !== 'term') return false
    return (
      term.term.suffixes.length === 0 &&
      (term.term.inner.kind === 'object' || term.term.inner.kind === 'array')
    )
  }

  // ==== 对象条目（R3） ====================================================

  private printObjectEntry(e: ObjectEntry): void {
    if (e.value === null) {
      this.emitTo(e.end) // 简写键
      return
    }
    const entryIndent = this.lineIndent()
    this.printKey(e.key, e.value.start)
    this.emitTo(e.value.start) // ':'
    // 作者在冒号之后断行：值另起一行，比条目缩进深一层；
    // 未断行则值留在键行，续行同样取条目缩进 +1 层
    const colon = this.m.prevReal(e.value.start)!
    if (this.m.brokeBetween(colon, e.value.start)) this.newline(entryIndent + this.is)
    this.printQuery(e.value, entryIndent + this.is)
  }

  private printKey(key: ObjectKey, bound: number): void {
    if (key.kind === 'query') {
      this.emitTo(key.q.start) // '('
      this.printQuery(key.q, this.lineIndent() + this.is)
      this.emitTo(bound) // '):'
      return
    }
    this.emitTo(bound)
  }

  // ==== if（R4）==========================================================

  private printIf(inner: Extract<TermInner, { kind: 'if' }>, innerEnd: number): void {
    const first = inner.clauses[0]!
    this.emitTo(first.cond.start) // 'if'
    // 子句锚点取 if 关键字所在列（而非行缩进）：if 处于悬挂组首元素、
    // 行中前缀（'| '、'key: ' 等）之后时，then/elif/else/end 与 if
    // 竖向对齐；if 起行时两者相等
    const ifIndent = this.col - 'if'.length
    const ifTok = this.m.prevReal(first.cond.start)!
    if (this.m.brokeBetween(ifTok, first.cond.start)) this.newline(ifIndent + this.is)
    this.printQuery(first.cond, ifIndent + this.is)

    let prevEnd = first.cond.end
    for (let ci = 0; ci < inner.clauses.length; ci++) {
      const clause = inner.clauses[ci]!
      if (ci > 0) {
        // elif：只在作者断行或关键字自身放不下时换行；条件另起由作者断行决定
        const elifTok = this.m.nextReal(prevEnd)!
        const broke = this.m.brokeBetween(prevEnd - 1, elifTok)
        const kwFits = this.effCol() + 1 + 4 <= this.opts.printWidth
        if (broke || !kwFits) this.newline(ifIndent)
        this.emitTo(clause.cond.start) // 'elif'
        if (this.m.brokeBetween(elifTok, clause.cond.start)) this.newline(ifIndent + this.is)
        this.printQuery(clause.cond, ifIndent + this.is)
        prevEnd = clause.cond.end
      }
      const thenTok = this.m.nextReal(clause.cond.end)!
      this.printClauseKeyword(clause.then, thenTok, ifIndent)
      prevEnd = clause.then.end
    }
    if (inner.elseQ !== null) {
      const elseTok = this.m.nextReal(prevEnd)!
      this.printClauseKeyword(inner.elseQ, elseTok, ifIndent)
      prevEnd = inner.elseQ.end
    }
    const endTok = innerEnd - 1
    const endBroke = this.m.brokeBetween(prevEnd - 1, endTok)
    const endFits = this.effCol() + 1 + 'end'.length <= this.opts.printWidth
    if (endBroke || !endFits) this.newline(ifIndent)
    this.emitTo(innerEnd) // 'end'
  }

  /**
   * then/else 子句：关键字只在作者断行或自身放不下时换行（回 if 缩进）；
   * 体放得下且非结构性多行时留在关键字行，否则另起一行（if 缩进 +1 层）
   */
  private printClauseKeyword(body: Query, kwTok: number, ifIndent: number): void {
    const kwText = this.tokens[kwTok].text
    const prevTok = this.m.prevReal(kwTok)!
    const broke = this.m.brokeBetween(prevTok, kwTok)
    const kwFits = this.effCol() + 1 + kwText.length <= this.opts.printWidth
    if (broke || !kwFits) this.newline(ifIndent)
    this.emitTo(body.start) // then / else
    const authorBroke = this.m.brokeBetween(kwTok, body.start)
    const onLine =
      !authorBroke &&
      !this.m.multiline(body) &&
      this.effCol() + 1 + this.m.flatWidth(body.start, body.end) <= this.opts.printWidth
    if (!onLine) this.newline(ifIndent + this.is)
    this.printQuery(body, ifIndent + this.is)
  }

  // ==== try（R5）=========================================================

  private printTry(inner: Extract<TermInner, { kind: 'try' }>): void {
    const tryTok = this.m.prevReal(inner.body.start)!
    this.emitTo(inner.body.start) // 'try'
    // 同 if：catch 与 try 关键字所在列对齐
    const tryIndent = this.col - 'try'.length
    if (this.m.brokeBetween(tryTok, inner.body.start)) this.newline(tryIndent + this.is)
    this.printExpr(inner.body, tryIndent + this.is)
    if (inner.catchBody === null) return
    const catchTok = this.m.nextReal(inner.body.end)!
    const broke = this.m.brokeBetween(inner.body.end - 1, catchTok)
    const kwFits = this.effCol() + 1 + 'catch'.length <= this.opts.printWidth
    if (broke || !kwFits) this.newline(tryIndent)
    this.emitTo(inner.catchBody.start) // 'catch'
    const authorBroke = this.m.brokeBetween(catchTok, inner.catchBody.start)
    const onLine =
      !authorBroke &&
      !this.m.multiline(inner.catchBody) &&
      this.effCol() + 1 + this.m.flatWidth(inner.catchBody.start, inner.catchBody.end) <=
        this.opts.printWidth
    if (!onLine) this.newline(tryIndent + this.is)
    this.printExpr(inner.catchBody, tryIndent + this.is)
  }

  // ==== 析构模式 ==========================================================

  private printPattern(p: PatternNode): void {
    switch (p.kind) {
      case 'pvar':
        this.emitTo(p.end)
        return
      case 'parray':
        this.emitTo(p.start + 1) // '['
        this.printGroup(p.start, p.end - 1, p.items, (it) => this.printPattern(it as PatternNode))
        return
      case 'pobject':
        this.emitTo(p.start + 1) // '{'
        this.printGroup(p.start, p.end - 1, p.entries, (e) =>
          this.printPatternEntry(e as PatternEntry)
        )
        return
    }
  }

  private printPatternEntry(e: PatternEntry): void {
    if (e.value === null) {
      this.emitTo(e.end) // $var 简写
      return
    }
    this.printKey(e.key, e.value.start)
    this.emitTo(e.value.start) // ':'
    this.printPattern(e.value)
  }
}
