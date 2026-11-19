/**
 * jq 递归下降 + Pratt 解析器 —— 仅供格式化器内部使用。
 *
 * 文法事实来源：jqlang/jq src/parser.y（以 gojqparser/parser.go.y 交叉
 * 核对）。与 yacc 冲突消解等价的要点：
 *
 *  - 优先级（低 → 高）：`|` ＞ `,` ＞ `//`(右) ＞ 赋值族(nonassoc) ＞
 *    `or` ＞ `and` ＞ 比较族(nonassoc) ＞ `+ -` ＞ `* / %` ＞ 词项。
 *  - `E as $p | body`：head 是 Expr 级（可含全部双目运算符，不含
 *    逗号/管道），body 是完整查询并吞掉剩余管道 —— 因此 as 绑定只能
 *    是逗号列表的最后一个条目。
 *  - try/catch 的 body 是「一个 Term」（含后缀）—— try 子句比一切
 *    双目运算符更早归约，`try a + b` 为 `(try a) + b`；管道/逗号
 *    须加括号。
 *  - 字段访问 `.foo` 要求 `.` 与名字列邻接（jqlang 的 FIELD 是词法
 *    token）；`."foo"` 是 parser 级规则，不要求邻接。
 *  - 一元负号的操作数是 Term：`-1 + 2` 为 `(-1) + 2`。
 *  - 对象值是「管道级的 Expr」（DictExpr），不含逗号与 as。
 *  - def 可以出现在任何查询位置（管道段、逗号条目、括号内、子句体）。
 *
 * 词法由 src/tokenizer.ts 提供（token 含注释）。解析器在「实 token」
 * （非注释）序列上工作；span 记录原始下标，打印器据此冲刷注释。
 */
import { isDotFieldName, tokenizeSource, type Token } from '../../tokenizer'
import type {
  ChainLink,
  CommaItem,
  Expr,
  ExprQuery,
  FuncDefNode,
  IfClause,
  ImportNode,
  ObjectEntry,
  ObjectKey,
  PatternEntry,
  PatternNode,
  PipeSegment,
  Program,
  Query,
  SemiGroup,
  Suffix,
  Term,
  TermExpr,
  TermInner
} from './ast'

export class ParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col: number
  ) {
    super(message)
  }
}

export interface ParseResult {
  /** 全量 token（含注释）—— 打印器的唯一 token 事实来源 */
  tokens: Token[]
  /** 非注释 token 的原始下标（解析器的工作序列） */
  real: number[]
  /** 一元 '-'/'+' 的原始下标集合（间距规则用） */
  unaryAt: Set<number>
  /** 对象构造的尾随逗号原始下标。分隔符、数组和模式不在其中。 */
  objectCommas: ReadonlySet<number>
  eol: '\r\n' | '\n'
  program: Program
}

export function parseProgram(src: string): ParseResult {
  const { tokens, eol } = tokenizeSource(src)
  const real: number[] = []
  const unaryAt = new Set<number>()
  const objectCommas = new Set<number>()
  for (let i = 0; i < tokens.length; i++) if (tokens[i].type !== 'comment') real.push(i)
  const program = new Parser(tokens, real, unaryAt, objectCommas).parseProgram()
  return { tokens, real, unaryAt, objectCommas, eol, program }
}

// Pratt 层级（低 → 高）；赋值族与比较族是 nonassoc（链式即报错）
const TIER_ALT = 1 // '//'
const TIER_SET = 2 // = |= += -= *= /= %= //=
const TIER_OR = 3 // or
const TIER_AND = 4 // and
const TIER_CMP = 5 // == != < <= > >=
const TIER_ADD = 6 // + -
const TIER_MUL = 7 // * / %

const SET_OPS = new Set(['=', '|=', '+=', '-=', '*=', '/=', '%=', '//='])
const CMP_OPS = new Set(['==', '!=', '<', '<=', '>', '>='])
const ADD_OPS = new Set(['+', '-'])
const MUL_OPS = new Set(['*', '/', '%'])

class Parser {
  /** 实 token 游标（real 数组中的下标） */
  #r = 0
  readonly #tokens: Token[]
  readonly #real: number[]
  readonly #unaryAt: Set<number>
  readonly #objectCommas: Set<number>

  constructor(tokens: Token[], real: number[], unaryAt: Set<number>, objectCommas: Set<number>) {
    this.#tokens = tokens
    this.#real = real
    this.#unaryAt = unaryAt
    this.#objectCommas = objectCommas
  }

  // ---- 基础设施 ----------------------------------------------------------

  #eof(): boolean {
    return this.#r >= this.#real.length
  }

  #tok(k = 0): Token | undefined {
    const i = this.#real[this.#r + k]
    return i === undefined ? undefined : this.#tokens[i]
  }

  /** 当前实 token 的原始下标 */
  #idx(k = 0): number {
    return this.#real[this.#r + k]
  }

  #isOp(text: string, k = 0): boolean {
    const t = this.#tok(k)
    return t !== undefined && t.type === 'operator' && t.text === text
  }

  #isKw(text: string, k = 0): boolean {
    const t = this.#tok(k)
    return t !== undefined && t.type === 'keyword' && t.text === text
  }

  /** 消费当前实 token，返回其原始下标 */
  #adv(): number {
    const i = this.#real[this.#r]
    if (i === undefined) this.#fail('unexpected end of input')
    this.#r++
    return i
  }

  #expectOp(text: string): number {
    if (!this.#isOp(text)) this.#fail(`expected '${text}'`)
    return this.#adv()
  }

  #expectKw(text: string): number {
    if (!this.#isKw(text)) this.#fail(`expected '${text}'`)
    return this.#adv()
  }

  #fail(message: string): never {
    const t = this.#tok()
    if (t === undefined) throw new ParseError(`${message} but reached end of input`, 0, 0)
    throw new ParseError(`${message} but got '${t.text}'`, t.line, t.col)
  }

  /** span 收尾：最后一个已消费实 token 的原始下标 + 1 */
  #endHere(): number {
    return this.#real[this.#r - 1] + 1
  }

  // ---- 程序层 ------------------------------------------------------------

  parseProgram(): Program {
    const start = this.#real[0] ?? 0
    let meta: Query | null = null
    if (this.#isKw('module')) {
      this.#adv()
      meta = this.parseQuery()
      this.#expectOp(';')
    }
    const imports: ImportNode[] = []
    while (this.#isKw('import') || this.#isKw('include')) {
      const kw = this.#tok()!.text as 'import' | 'include'
      const impStart = this.#adv()
      const path = this.#expectString('import path')
      let alias: number | null = null
      if (kw === 'import') {
        this.#expectKw('as')
        alias = this.#expectName('import alias')
      }
      let impMeta: Query | null = null
      if (!this.#isOp(';')) impMeta = this.parseQuery()
      this.#expectOp(';')
      imports.push({ start: impStart, end: this.#endHere(), kw, path, alias, meta: impMeta })
    }
    let body: Query | null = null
    if (!this.#eof()) body = this.parseQuery()
    if (!this.#eof()) this.#fail('unexpected token after program')
    const end = this.#real.length > 0 ? this.#real[this.#real.length - 1] + 1 : 0
    return { start, end, meta, imports, body }
  }

  #expectString(what: string): number {
    const t = this.#tok()
    if (t === undefined || t.type !== 'string') this.#fail(`expected string as ${what}`)
    return this.#adv()
  }

  // ---- 查询层：pipe > comma > item ---------------------------------------

  parseQuery(): Query {
    const start = this.#idx()
    const segments: PipeSegment[] = []
    for (;;) {
      const segStart = this.#idx()
      const items: CommaItem[] = [this.#parseCommaItem()]
      while (this.#isOp(',')) {
        this.#adv()
        items.push(this.#parseCommaItem())
      }
      segments.push({ start: segStart, end: this.#endHere(), head: this.#toQuery(items) })
      if (!this.#isOp('|')) break
      this.#adv()
    }
    if (segments.length === 1) return segments[0].head
    return { kind: 'pipe', start, end: this.#endHere(), segments }
  }

  /**
   * 逗号条目列表 → 查询。单项且无前导 def 时直接用条目内容；否则包一层
   * 逗号节点（单项带 def 时也包 —— def 不能丢）。
   */
  #toQuery(items: CommaItem[]): Query {
    if (items.length === 1 && items[0].defs.length === 0 && items[0].head !== null)
      return items[0].head
    return { kind: 'comma', start: items[0].start, end: items[items.length - 1].end, items }
  }

  #parseCommaItem(): CommaItem {
    const start = this.#idx()
    const defs: FuncDefNode[] = []
    while (this.#isKw('def')) defs.push(this.#parseFuncDef())
    // 宽容：文件以悬空 def 结尾（严格 jq 要求 def 后跟查询）。
    // 仅在确实收集到 def 时触发 —— 否则 `a |` 这类残缺输入仍须报错
    if (this.#eof() && defs.length > 0) return { start, end: this.#endHere(), defs, head: null }
    // head 节点的 span 从 head 首个 token 起（不含前导 def）——
    // def 之后是否断行等边界判定要用到它
    const headStart = this.#idx()
    let head: ExprQuery | Extract<Query, { kind: 'as' | 'label' }>
    if (this.#isKw('label')) {
      this.#adv()
      const v = this.#expectVariable()
      this.#expectOp('|')
      const body = this.parseQuery()
      head = { kind: 'label', start: headStart, end: this.#endHere(), varTok: v, body }
    } else {
      const expr = this.#parseExpr(TIER_ALT)
      if (this.#isKw('as')) {
        this.#adv()
        const patterns = this.#parsePatterns()
        this.#expectOp('|')
        const body = this.parseQuery()
        head = {
          kind: 'as',
          start: headStart,
          end: this.#endHere(),
          head: { kind: 'expr', start: expr.start, end: expr.end, expr },
          patterns,
          body
        }
      } else {
        head = { kind: 'expr', start: headStart, end: this.#endHere(), expr }
      }
    }
    return { start, end: this.#endHere(), defs, head }
  }

  #expectVariable(): number {
    const t = this.#tok()
    if (t === undefined || t.type !== 'variable') this.#fail('expected $variable')
    return this.#adv()
  }

  #parseFuncDef(): FuncDefNode {
    const start = this.#adv() // def
    this.#expectName('function name')
    let params: FuncDefNode['params'] = null
    if (this.#isOp('(')) {
      this.#adv() // '('
      params = []
      for (;;) {
        const p = this.#expectName('function parameter')
        params.push({ start: p, end: this.#endHere() })
        if (!this.#isOp(';')) break
        this.#adv()
      }
      this.#expectOp(')')
    }
    this.#expectOp(':')
    const body = this.parseQuery()
    this.#expectOp(';')
    return { start, end: this.#endHere(), params, body }
  }

  /**
   * 名字（含 a::b 模块链）：ident / 常量 / 变量 / 格式；对象键与模式键
   * 还允许关键字（`{reduce: 1}`、`{if: 1}` —— jqlang 的 Keyword 产生式），
   * def 名 / 参数 / import 别名则不允许。
   */
  #expectName(what: string, allowKeyword = false): number {
    const t = this.#tok()
    if (t === undefined || (!this.#isNameStart(t) && !(allowKeyword && t.type === 'keyword'))) {
      this.#fail(`expected ${what}`)
    }
    const first = this.#adv()
    this.#skipModuleChain()
    return first
  }

  #isNameStart(t: Token): boolean {
    return (
      t.type === 'ident' || t.type === 'constant' || t.type === 'variable' || t.type === 'format'
    )
  }

  /** 消费名字后的 `:: name` 链（jqlang 词法里是单个 IDENT token） */
  #skipModuleChain(): void {
    while (this.#isOp(':', 0) && this.#isOp(':', 1)) {
      const t = this.#tok(2)
      if (t === undefined || !this.#isNameStart(t)) break
      this.#adv()
      this.#adv()
      this.#adv()
    }
  }

  // ---- 表达式层：Pratt ---------------------------------------------------

  #parseExpr(tier: number): Expr {
    const start = this.#idx()
    const first: Expr = tier >= TIER_MUL ? this.#parseTermExpr() : this.#parseExpr(tier + 1)
    const links: ChainLink[] = []
    for (;;) {
      const opText = this.#binopAt(tier)
      if (opText === null) break
      // nonassoc 层不允许链式（`a = b = c`、`a < b < c` 是语法错误）
      if (links.length > 0 && (tier === TIER_SET || tier === TIER_CMP)) {
        this.#fail(`non-associative operator '${opText}' cannot be chained`)
      }
      const op = this.#adv()
      const operand: Expr = tier >= TIER_MUL ? this.#parseTermExpr() : this.#parseExpr(tier + 1)
      links.push({ op, operand })
    }
    if (links.length === 0) return first
    return { kind: 'chain', start, end: this.#endHere(), first, links }
  }

  #parseTermExpr(): TermExpr {
    const start = this.#idx()
    const term = this.parseTerm()
    return { kind: 'term', start, end: this.#endHere(), term }
  }

  #binopAt(tier: number): string | null {
    const t = this.#tok()
    if (t === undefined) return null
    if (t.type === 'operator') {
      if (tier === TIER_ALT && t.text === '//') return '//'
      if (tier === TIER_SET && SET_OPS.has(t.text)) return t.text
      if (tier === TIER_CMP && CMP_OPS.has(t.text)) return t.text
      if (tier === TIER_ADD && ADD_OPS.has(t.text)) return t.text
      if (tier === TIER_MUL && MUL_OPS.has(t.text)) return t.text
      return null
    }
    if (t.type === 'keyword') {
      if (tier === TIER_OR && t.text === 'or') return 'or'
      if (tier === TIER_AND && t.text === 'and') return 'and'
    }
    return null
  }

  // ---- 词项层 ------------------------------------------------------------

  parseTerm(): Term {
    const start = this.#idx()
    const inner = this.#parseTermInner()
    const suffixes = this.#parseSuffixes()
    return { start, end: this.#endHere(), inner, suffixes }
  }

  #parseTermInner(): TermInner {
    const t = this.#tok()
    if (t === undefined) this.#fail('expected a term')

    if (t.type === 'operator') {
      switch (t.text) {
        case '.': {
          const dotTok = this.#adv()
          // 邻接的 ident/关键字/常量 是字段名（FIELD 语义）；string 是
          // parser 级规则不要求邻接；其余（含 `.[`）是身份
          const n = this.#tok()
          if (isDotFieldName(this.#tokens[dotTok], n)) {
            const name = this.#adv()
            return { kind: 'field', dotTok, name }
          }
          if (n !== undefined && n.type === 'string') {
            const strTok = this.#adv()
            return { kind: 'field', dotTok, name: strTok }
          }
          return { kind: 'identity' }
        }
        case '..':
          this.#adv()
          return { kind: 'recurse' }
        case '$': {
          // `$$$name`（jq builtin.jq 私有技巧）
          if (this.#isOp('$', 1) && this.#isOp('$', 2)) {
            const t3 = this.#tok(3)
            if (t3 !== undefined && t3.type === 'variable') {
              this.#adv()
              this.#adv()
              this.#adv()
              const varTok = this.#adv()
              return { kind: 'rawvar', varTok }
            }
          }
          this.#fail(`unexpected token '$'`)
          break
        }
        case '(': {
          this.#adv()
          const body = this.parseQuery()
          this.#expectOp(')')
          return { kind: 'paren', body }
        }
        case '[': {
          this.#adv()
          if (this.#isOp(']')) {
            this.#adv()
            return { kind: 'array', body: null }
          }
          const body = this.parseQuery()
          this.#expectOp(']')
          return { kind: 'array', body }
        }
        case '{':
          return this.#parseObject()
        case '-':
        case '+': {
          const op = this.#adv()
          this.#unaryAt.add(op)
          const operand = this.parseTerm()
          return { kind: 'unary', op, operand }
        }
        default:
          this.#fail(`unexpected operator '${t.text}'`)
      }
    }

    switch (t.type) {
      case 'number': {
        const tok = this.#adv()
        return { kind: 'number', tok }
      }
      case 'string': {
        const tok = this.#adv()
        return { kind: 'string', tok }
      }
      case 'format': {
        const tok = this.#adv()
        const n = this.#tok()
        if (n !== undefined && n.type === 'string') {
          const str = this.#adv()
          return { kind: 'format', tok, str }
        }
        return { kind: 'format', tok, str: null }
      }
      case 'variable':
      case 'ident':
      case 'constant': {
        const name = this.#expectName('function name')
        if (this.#isOp('(')) {
          this.#adv()
          const args = [this.parseQuery()]
          while (this.#isOp(';')) {
            this.#adv()
            args.push(this.parseQuery())
          }
          this.#expectOp(')')
          return { kind: 'func', name, args }
        }
        return { kind: 'func', name, args: null }
      }
      case 'keyword':
        switch (t.text) {
          case 'if':
            return this.#parseIf()
          case 'try': {
            this.#adv()
            // try/catch 的 body 是一个 Term（见文件头注释）
            const body = this.#parseTermExpr()
            let catchBody: Expr | null = null
            if (this.#isKw('catch')) {
              this.#adv()
              catchBody = this.#parseTermExpr()
            }
            return { kind: 'try', body, catchBody }
          }
          case 'reduce':
          case 'foreach': {
            const isReduce = t.text === 'reduce'
            this.#adv()
            const src = this.#parseExpr(TIER_ALT)
            this.#expectKw('as')
            const pattern = this.#parsePattern()
            const group = this.#parseSemiGroup()
            return isReduce
              ? { kind: 'reduce', src, pattern, group }
              : { kind: 'foreach', src, pattern, group }
          }
          case 'break': {
            this.#adv()
            const varTok = this.#expectVariable()
            return { kind: 'break', varTok }
          }
          default:
            this.#fail(`unexpected keyword '${t.text}'`)
        }
        break
      default:
        break
    }
    this.#fail(`unexpected token '${t.text}'`)
  }

  #parseIf(): TermInner {
    this.#adv() // if
    const clauses: IfClause[] = []
    const cond = this.parseQuery()
    this.#expectKw('then')
    const then = this.parseQuery()
    clauses.push({ cond, then })
    while (this.#isKw('elif')) {
      this.#adv()
      const c = this.parseQuery()
      this.#expectKw('then')
      const b = this.parseQuery()
      clauses.push({ cond: c, then: b })
    }
    let elseQ: Query | null = null
    if (this.#isKw('else')) {
      this.#adv()
      elseQ = this.parseQuery()
    }
    this.#expectKw('end')
    return { kind: 'if', clauses, elseQ }
  }

  /** reduce/foreach 的 `( q; q[; q] )` 分组 */
  #parseSemiGroup(): SemiGroup {
    const start = this.#idx()
    this.#expectOp('(')
    const parts = [this.parseQuery()]
    while (this.#isOp(';')) {
      this.#adv()
      parts.push(this.parseQuery())
    }
    this.#expectOp(')')
    return { start, end: this.#endHere(), parts }
  }

  // ---- 后缀链 ------------------------------------------------------------

  #parseSuffixes(): Suffix[] {
    const suffixes: Suffix[] = []
    for (;;) {
      if (this.#isOp('[')) {
        suffixes.push(this.#parseBracketSuffix())
        continue
      }
      if (this.#isOp('?')) {
        const start = this.#adv()
        suffixes.push({ kind: 'optional', start, end: this.#endHere() })
        continue
      }
      if (this.#isOp('.')) {
        const dotTok = this.#idx()
        const n = this.#tok(1)
        if (isDotFieldName(this.#tokens[dotTok], n)) {
          this.#adv()
          const name = this.#adv()
          suffixes.push({ kind: 'field', start: dotTok, end: this.#endHere(), dotTok, name })
          continue
        }
        if (n !== undefined && n.type === 'string') {
          this.#adv()
          const name = this.#adv()
          suffixes.push({ kind: 'field', start: dotTok, end: this.#endHere(), dotTok, name })
          continue
        }
        if (this.#isOp('[', 1)) {
          this.#adv() // .
          suffixes.push(this.#parseBracketSuffix())
          continue
        }
        this.#fail(`expected field name, string or '[' after '.'`)
      }
      break
    }
    return suffixes
  }

  #parseBracketSuffix(): Suffix {
    const start = this.#idx()
    this.#adv() // [
    if (this.#isOp(']')) {
      this.#adv()
      return { kind: 'iter', start, end: this.#endHere() }
    }
    if (this.#isOp(':')) {
      this.#adv()
      const to = this.parseQuery()
      this.#expectOp(']')
      return { kind: 'slice', start, end: this.#endHere(), from: null, to }
    }
    const q = this.parseQuery()
    if (this.#isOp(']')) {
      this.#adv()
      return { kind: 'index', start, end: this.#endHere(), q }
    }
    this.#expectOp(':')
    if (this.#isOp(']')) {
      this.#adv()
      return { kind: 'slice', start, end: this.#endHere(), from: q, to: null }
    }
    const to = this.parseQuery()
    this.#expectOp(']')
    return { kind: 'slice', start, end: this.#endHere(), from: q, to }
  }

  // ---- 对象构造 ----------------------------------------------------------

  #parseObject(): TermInner {
    this.#adv() // {
    const entries: ObjectEntry[] = []
    let trailingSep: number | null = null
    if (!this.#isOp('}')) {
      for (;;) {
        entries.push(this.#parseObjectEntry())
        if (this.#isOp(',')) {
          const sep = this.#adv()
          if (this.#isOp('}')) {
            trailingSep = sep
            this.#objectCommas.add(sep)
            break
          }
          continue
        }
        break
      }
    }
    this.#expectOp('}')
    return { kind: 'object', entries, trailingSep }
  }

  #parseObjectEntry(): ObjectEntry {
    const start = this.#idx()
    const t = this.#tok()
    if (t === undefined) this.#fail('expected object entry')

    if (this.#isOp('(')) {
      this.#adv()
      const q = this.parseQuery()
      this.#expectOp(')')
      this.#expectOp(':')
      const value = this.#parseObjectVal()
      return { start, end: this.#endHere(), key: { kind: 'query', q }, value }
    }

    if (t.type === 'string') {
      const tok = this.#adv()
      if (this.#isOp(':')) {
        this.#adv()
        const value = this.#parseObjectVal()
        return { start, end: this.#endHere(), key: { kind: 'string', tok }, value }
      }
      return { start, end: this.#endHere(), key: { kind: 'string', tok }, value: null }
    }

    if (
      t.type === 'ident' ||
      t.type === 'constant' ||
      t.type === 'keyword' ||
      t.type === 'variable'
    ) {
      const key: ObjectKey = { kind: 'name', tok: this.#expectName('object key', true) }
      if (this.#isOp(':')) {
        this.#adv()
        const value = this.#parseObjectVal()
        return { start, end: this.#endHere(), key, value }
      }
      return { start, end: this.#endHere(), key, value: null }
    }

    this.#fail(`unexpected token '${t.text}' in object`)
  }

  /** 对象值：管道级的 Expr（不含逗号与 as —— 与 jqlang DictExpr 一致） */
  #parseObjectVal(): Query {
    const start = this.#idx()
    const first = this.#parseValSegment()
    if (!this.#isOp('|')) return first.head
    const segments: PipeSegment[] = [{ start: first.start, end: first.end, head: first.head }]
    while (this.#isOp('|')) {
      this.#adv()
      const seg = this.#parseValSegment()
      segments.push({ start: seg.start, end: seg.end, head: seg.head })
    }
    return { kind: 'pipe', start, end: this.#endHere(), segments }
  }

  #parseValSegment(): PipeSegment {
    const start = this.#idx()
    const expr = this.#parseExpr(TIER_ALT)
    if (this.#isKw('as')) {
      this.#fail("object value cannot contain 'as' (wrap in parentheses)")
    }
    return {
      start,
      end: this.#endHere(),
      head: { kind: 'expr', start, end: this.#endHere(), expr }
    }
  }

  // ---- 析构模式 ----------------------------------------------------------

  #parsePatterns(): PatternNode[] {
    const patterns = [this.#parsePattern()]
    while (this.#isOp('?//')) {
      this.#adv()
      patterns.push(this.#parsePattern())
    }
    return patterns
  }

  #parsePattern(): PatternNode {
    const start = this.#idx()
    const t = this.#tok()
    if (t === undefined) this.#fail('expected pattern')

    if (t.type === 'variable') {
      const tok = this.#adv()
      return { kind: 'pvar', start, end: this.#endHere(), tok }
    }
    if (this.#isOp('[')) {
      this.#adv()
      const items = [this.#parsePattern()]
      while (this.#isOp(',')) {
        this.#adv()
        items.push(this.#parsePattern())
      }
      this.#expectOp(']')
      return { kind: 'parray', start, end: this.#endHere(), items }
    }
    if (this.#isOp('{')) {
      this.#adv()
      const entries: PatternEntry[] = []
      if (!this.#isOp('}')) {
        for (;;) {
          entries.push(this.#parsePatternEntry())
          if (this.#isOp(',')) {
            this.#adv()
            continue
          }
          break
        }
      }
      this.#expectOp('}')
      return { kind: 'pobject', start, end: this.#endHere(), entries }
    }
    this.#fail(`unexpected token '${t.text}' in pattern`)
  }

  #parsePatternEntry(): PatternEntry {
    const start = this.#idx()
    const t = this.#tok()
    if (t === undefined) this.#fail('expected pattern entry')

    if (this.#isOp('(')) {
      this.#adv()
      const q = this.parseQuery()
      this.#expectOp(')')
      this.#expectOp(':')
      const value = this.#parsePattern()
      return { start, end: this.#endHere(), key: { kind: 'query', q }, value }
    }
    if (t.type === 'string') {
      const tok = this.#adv()
      this.#expectOp(':')
      const value = this.#parsePattern()
      return { start, end: this.#endHere(), key: { kind: 'string', tok }, value }
    }
    if (t.type === 'variable') {
      const key: ObjectKey = { kind: 'name', tok: this.#expectName('pattern key', true) }
      if (this.#isOp(':')) {
        this.#adv()
        const value = this.#parsePattern()
        return { start, end: this.#endHere(), key, value }
      }
      return { start, end: this.#endHere(), key, value: null } // `{$a}` 简写
    }
    if (t.type === 'ident' || t.type === 'constant' || t.type === 'keyword') {
      const key: ObjectKey = { kind: 'name', tok: this.#expectName('pattern key', true) }
      this.#expectOp(':')
      const value = this.#parsePattern()
      return { start, end: this.#endHere(), key, value }
    }
    this.#fail(`unexpected token '${t.text}' in pattern entry`)
  }
}
