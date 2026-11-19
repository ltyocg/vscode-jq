/**
 * 宽度与多行判定 —— 打印器的测量层。
 *
 *  - flatWidth：把一段 token 区间按发射同款间距规则平铺到一行时的宽度。
 *    必须与 printer 的发射路径消费同一个 gapBetween，两侧才不会漂移。
 *  - multiline(node)：「结构性多行」—— 与所在列无关、必然占据多行的
 *    节点（按 R2 展开的子组、作者断行的链、按 R4/R5 展开的 if/try、
 *    def、悬空 def 等）。行宽超限（R2 条件③）是位置相关的，不属于
 *    这里，由打印时按当前列判定。
 *  - groupForced：括号组的位置无关展开条件（R2 条件①②④）。
 *
 * 多行字符串（含裸换行的字面量）不算结构性多行：它不改变周围结构，
 * 原样发射即可。
 */
import type { Token } from '../tokenizer'
import { gapBetween, type FmtToken } from './spacing'
import type {
  ChainLink,
  CommaItem,
  CommaNode,
  Expr,
  Node,
  ObjectEntry,
  PatternEntry,
  PatternNode,
  PipeNode,
  Query,
  Suffix,
  Term
} from './parser/ast'

/** 任意可判多行的节点（带可选 kind 判别字段） */
export type AnyNode = Node & { kind?: string }

export class Metrics {
  readonly #flatMemo = new Map<string, number>()
  readonly #firstLineMemo = new Map<string, number>()
  readonly #multilineMemo = new Map<unknown, boolean>()
  readonly #groupMemo = new Map<number, boolean>()

  readonly #tokens: Token[]
  readonly #real: number[]
  readonly #unaryAt: Set<number>
  readonly #printWidth: number

  constructor(tokens: Token[], real: number[], unaryAt: Set<number>, printWidth: number) {
    this.#tokens = tokens
    this.#real = real
    this.#unaryAt = unaryAt
    this.#printWidth = printWidth
  }

  // ---- token 工具 --------------------------------------------------------

  /** ≥ from 的最近实 token 原始下标 */
  nextReal(from: number): number | undefined {
    // 二分（real 有序）
    let lo = 0
    let hi = this.#real.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.#real[mid] < from) lo = mid + 1
      else hi = mid
    }
    return this.#real[lo]
  }

  /** < before 的最近实 token 原始下标 */
  prevReal(before: number): number | undefined {
    let lo = 0
    let hi = this.#real.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.#real[mid] < before) lo = mid + 1
      else hi = mid
    }
    return lo > 0 ? this.#real[lo - 1] : undefined
  }

  /** token 结束行（多行 token：起始行 + 文本中的换行数） */
  endLine(idx: number): number {
    const t = this.#tokens[idx]
    let n = 0
    for (let i = 0; i < t.text.length; i++) if (t.text.charCodeAt(i) === 10) n++
    return t.line + n
  }

  /** 相邻两个实 token 之间作者是否断过行（注释蕴含换行，天然覆盖） */
  brokeBetween(aIdx: number, bIdx: number): boolean {
    return this.#tokens[bIdx].line > this.#tokens[aIdx].line
  }

  #fmtTok(idx: number): FmtToken {
    const t = this.#tokens[idx]
    return { ...t, unary: this.#unaryAt.has(idx) }
  }

  // ---- 平铺宽度 ----------------------------------------------------------

  /** [from, to) 区间实 token 的平铺宽度（跳过注释；含区间内 gap） */
  flatWidth(from: number, to: number): number {
    const key = `${from}:${to}`
    const memo = this.#flatMemo.get(key)
    if (memo !== undefined) return memo
    let width = 0
    let prev: FmtToken | undefined
    const stack: string[] = []
    for (let r = 0; r < this.#real.length; r++) {
      const idx = this.#real[r]
      if (idx < from) continue
      if (idx >= to) break
      const t = this.#tokens[idx]
      if (t.type === 'comment') continue
      const ft = this.#fmtTok(idx)
      const enclosing = stack.length > 0 ? stack[stack.length - 1] : ''
      if (prev !== undefined) {
        if (gapBetween(prev, ft, enclosing) === 'space') width++
      }
      width += t.text.length
      if (t.type === 'operator') {
        if (t.text === '(' || t.text === '[' || t.text === '{') stack.push(t.text)
        else if (t.text === ')' || t.text === ']' || t.text === '}') stack.pop()
      }
      prev = ft
    }
    this.#flatMemo.set(key, width)
    return width
  }

  get width(): number {
    return this.#printWidth
  }

  /**
   * [from, to) 区间实 token 到第一处源码断点为止的平铺宽度；区间内
   * 无换行时＝flatWidth。「行内放得下吗」的贪心口径（首行贪心）：
   * 结构性多行的操作数只量作者写在首行的部分 —— 运算符行内放得下就
   * 保持行内，让多行结构自己展开（jqjq 语料 `|= map(` 的形态），
   * 不因整段平铺放不下而强制下沉。
   */
  firstLineWidth(from: number, to: number): number {
    const key = `${from}:${to}`
    const memo = this.#firstLineMemo.get(key)
    if (memo !== undefined) return memo
    let width = 0
    let prev: FmtToken | undefined
    const stack: string[] = []
    for (let r = 0; r < this.#real.length; r++) {
      const idx = this.#real[r]
      if (idx < from) continue
      if (idx >= to) break
      const t = this.#tokens[idx]
      if (t.type === 'comment') continue
      if (prev !== undefined && t.line > prev.line) break // 作者断点：首行到此为止
      const ft = this.#fmtTok(idx)
      const enclosing = stack.length > 0 ? stack[stack.length - 1] : ''
      if (prev !== undefined) {
        if (gapBetween(prev, ft, enclosing) === 'space') width++
      }
      width += t.text.length
      if (t.type === 'operator') {
        if (t.text === '(' || t.text === '[' || t.text === '{') stack.push(t.text)
        else if (t.text === ')' || t.text === ']' || t.text === '}') stack.pop()
      }
      prev = ft
    }
    this.#firstLineMemo.set(key, width)
    return width
  }

  // ---- 括号组：位置无关的展开条件（R2 ①②④） ----------------------------

  /**
   * 作者在组自身层级的断行/注释（条件①②）：元素边界有源码换行，或组
   * 内有不属于任何子节点的注释。空组同理（`[\n]` 的换行折叠，注释除外）。
   */
  groupAuthorBreak(openIdx: number, closerIdx: number, children: Node[]): boolean {
    if (children.length === 0) return this.#hasOwnComment(openIdx, closerIdx, children)
    if (this.brokeBetween(openIdx, children[0]!.start)) return true
    for (let i = 1; i < children.length; i++) {
      if (this.brokeBetween(children[i - 1]!.end - 1, children[i]!.start)) return true
    }
    if (this.brokeBetween(children[children.length - 1]!.end - 1, closerIdx)) return true
    return this.#hasOwnComment(openIdx, closerIdx, children)
  }

  /**
   * 组是否「被迫展开」：自身元素边界有源码换行、自身层级有注释、或任一
   * 元素结构性多行。行宽（条件③）由打印器按当前列补判。
   * children 为组的元素节点（逗号列表已拆开），span 覆盖元素自身。
   */
  groupForced(openIdx: number, closerIdx: number, children: Node[]): boolean {
    const memoKey = openIdx
    const memo = this.#groupMemo.get(memoKey)
    if (memo !== undefined) return memo
    let forced = this.groupAuthorBreak(openIdx, closerIdx, children)
    // ④ 元素结构性多行
    if (!forced) {
      for (const c of children) {
        if (this.multiline(c)) {
          forced = true
          break
        }
      }
    }
    this.#groupMemo.set(memoKey, forced)
    return forced
  }

  /** 组内（开括号、闭括号之间）是否有不属于任何子节点 span 的注释 */
  #hasOwnComment(openIdx: number, closerIdx: number, children: Node[]): boolean {
    for (let i = openIdx + 1; i < closerIdx; i++) {
      if (this.#tokens[i]!.type !== 'comment') continue
      let inside = false
      for (const c of children) {
        if (i >= c.start && i < c.end) {
          inside = true
          break
        }
      }
      if (!inside) return true
    }
    return false
  }

  /** 组的闭括号前（最后一个子节点之后）是否有注释 */
  hasCommentBefore(closerIdx: number, lastChildEnd: number): boolean {
    for (let i = lastChildEnd; i < closerIdx; i++) {
      if (this.#tokens[i]!.type === 'comment') return true
    }
    return false
  }

  /** [from, to) 内首个注释 token 的下标（无则 undefined） */
  firstCommentBetween(from: number, to: number): number | undefined {
    for (let i = from; i < to; i++) {
      if (this.#tokens[i]!.type === 'comment') return i
    }
    return undefined
  }

  // ---- 结构性多行 --------------------------------------------------------

  multiline(n: unknown): boolean {
    if (n === null || n === undefined) return false
    if (typeof n !== 'object') return false
    const memo = this.#multilineMemo.get(n)
    if (memo !== undefined) return memo
    const result = this.#multiline(n)
    this.#multilineMemo.set(n, result)
    return result
  }

  #multiline(n: unknown): boolean {
    // CommaItem：有 def 即多行；否则看 head
    if ('defs' in (n as object)) {
      const item = n as CommaItem
      return item.defs.length > 0 || this.multiline(item.head)
    }
    // 无 kind 字段的：Term（inner/suffixes）或对象/模式条目（key/value）
    const kind = (n as { kind?: string }).kind
    if (kind === undefined) {
      if ('inner' in (n as object)) return this.#multilineTerm(n as Term)
      if ('key' in (n as object)) {
        const e = n as ObjectEntry | PatternEntry
        return e.value !== null && this.multiline(e.value)
      }
      return false
    }
    switch (kind) {
      // ---- 查询层 ----
      case 'pipe': {
        const p = n as PipeNode
        if (p.segments.some((s) => this.multiline(s.head))) return true
        for (let i = 1; i < p.segments.length; i++) {
          const bar = this.prevReal(p.segments[i]!.start)
          if (
            bar !== undefined &&
            (this.brokeBetween(p.segments[i - 1]!.end - 1, bar) ||
              this.brokeBetween(bar, p.segments[i]!.start))
          ) {
            return true
          }
        }
        return false
      }
      case 'comma': {
        const c = n as CommaNode
        if (c.items.some((it) => this.multiline(it))) return true
        for (let i = 1; i < c.items.length; i++) {
          const sep = this.prevReal(c.items[i]!.start)
          if (sep !== undefined && this.brokeBetween(c.items[i - 1]!.end - 1, sep)) return true
        }
        return false
      }
      case 'as': {
        const a = n as Extract<Query, { kind: 'as' }>
        return (
          this.multiline(a.head) ||
          this.multiline(a.body) ||
          a.patterns.some((p) => this.multiline(p))
        )
      }
      case 'label': {
        const l = n as Extract<Query, { kind: 'label' }>
        return this.multiline(l.body)
      }
      case 'expr': {
        const e = n as Extract<Query, { kind: 'expr' }>
        return this.multiline(e.expr)
      }
      // ---- 表达式层 ----
      case 'term': {
        const e = n as Extract<Expr, { kind: 'term' }>
        return this.multilineTermWithSuffixes(e.term)
      }
      case 'chain': {
        const c = n as Extract<Expr, { kind: 'chain' }>
        if (this.multiline(c.first)) return true
        let prev = c.first
        for (const link of c.links) {
          if (
            this.brokeBetween(prev.end - 1, link.op) ||
            this.brokeBetween(link.op, link.operand.start)
          )
            return true
          if (this.multiline(link.operand)) return true
          prev = link.operand
        }
        return false
      }
      // ---- 模式层 ----
      case 'pvar':
        return false
      case 'parray': {
        const p = n as Extract<PatternNode, { kind: 'parray' }>
        return this.groupForced(p.start, p.end - 1, p.items)
      }
      case 'pobject': {
        const p = n as Extract<PatternNode, { kind: 'pobject' }>
        return this.groupForced(p.start, p.end - 1, p.entries)
      }
      default:
        return false
    }
  }

  #multilineTerm(t: Term): boolean {
    const innerEnd = t.suffixes.length > 0 ? t.suffixes[0]!.start : t.end
    const inner = t.inner
    switch (inner.kind) {
      case 'identity':
      case 'recurse':
      case 'field':
      case 'number':
      case 'string': // 多行字符串不算结构性多行（见文件头）
      case 'format':
      case 'break':
      case 'rawvar':
        return false
      case 'func':
        if (inner.args === null) return false
        return this.groupForced(this.prevReal(inner.args[0]!.start)!, innerEnd - 1, inner.args)
      case 'object':
        return this.groupForced(t.start, innerEnd - 1, inner.entries)
      case 'array':
        if (inner.body === null) return false
        return this.groupForced(t.start, innerEnd - 1, this.unwrapElements(inner.body))
      case 'paren':
        return this.groupForced(t.start, innerEnd - 1, this.unwrapElements(inner.body))
      case 'unary':
        return this.multiline(inner.operand)
      case 'if': {
        for (const c of inner.clauses) {
          if (this.multiline(c.cond) || this.multiline(c.then)) return true
          const thenTok = this.nextReal(c.cond.end)
          if (thenTok !== undefined && this.brokeBetween(c.cond.end - 1, thenTok)) return true
        }
        if (inner.elseQ !== null) {
          if (this.multiline(inner.elseQ)) return true
          const lastThen = inner.clauses[inner.clauses.length - 1]!.then
          const elseTok = this.nextReal(lastThen.end)
          if (elseTok !== undefined && this.brokeBetween(lastThen.end - 1, elseTok)) return true
        }
        return false
      }
      case 'try': {
        if (this.multiline(inner.body)) return true
        if (this.brokeBetween(t.start, inner.body.start)) return true
        if (inner.catchBody !== null) {
          if (this.multiline(inner.catchBody)) return true
          const catchTok = this.nextReal(inner.body.end)
          if (catchTok !== undefined && this.brokeBetween(inner.body.end - 1, catchTok)) return true
        }
        return false
      }
      case 'reduce':
      case 'foreach': {
        if (this.multiline(inner.src)) return true
        if (this.multiline(inner.pattern)) return true
        return this.groupForced(inner.group.start, inner.group.end - 1, inner.group.parts)
      }
    }
  }

  /** 后缀括号组（下标/切片）的展开判定 */
  #multilineSuffix(s: Suffix): boolean {
    if (s.kind === 'index') return this.groupForced(s.start, s.end - 1, [s.q])
    if (s.kind === 'slice') {
      const children: Node[] = []
      if (s.from !== null) children.push(s.from)
      if (s.to !== null) children.push(s.to)
      return this.groupForced(s.start, s.end - 1, children)
    }
    return false
  }

  /** Term 的多行判定（inner + 后缀括号组）—— 打印与测量共用的入口 */
  multilineTermWithSuffixes(t: Term): boolean {
    if (this.#multilineTerm(t)) return true
    for (const s of t.suffixes) {
      if (this.#multilineSuffix(s)) return true
    }
    return false
  }

  /** 括号体（paren/array）的元素：逗号列表拆开，单个原样 */
  unwrapElements(body: Query): Node[] {
    return body.kind === 'comma' ? body.items : [body]
  }

  /** 链接的作者断行（打印器与多行判定共用同一口径） */
  linkBroke(prev: Expr, link: ChainLink): boolean {
    return (
      this.brokeBetween(prev.end - 1, link.op) || this.brokeBetween(link.op, link.operand.start)
    )
  }
}
