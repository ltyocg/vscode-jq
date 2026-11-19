/**
 * 回车智能缩进 —— 以格式化器为 oracle。
 *
 * VS Code 没有提供「回车时按语法计算缩进」的钩子（indentationRules 与
 * onEnterRules 只有正则、只能 ±1 级），本模块换一条路：把光标前的文本
 * 构造成探针程序，交给内置格式化器排版，探针里哨兵变量所在行的缩进
 * 就是回车后新行应有的缩进 —— 与格式化器的输出规范天然一致（包括
 * 悬挂组对齐开括号列＋2、行中 if 的子句列对齐这类正则做不到的缩进）。
 *
 * 回车时刻的前缀几乎总是不完整程序（`foo |`、`{a: 1,`），不能直接解析。
 * 策略是扫描前缀 token 维护「未闭合构造」栈（括号组／if 子句相位／
 * def），据此把前缀补全成可解析的探针：
 *
 *     prefix + PRE + '\n' + 哨兵 + POST
 *
 * PRE 把文法推进到「值位置」（`as $x` 之后补 `|`、完整元素之后补 `,`），
 * POST 自内向外闭合所有未闭合构造（reduce 组补 `; .`、if 按相位补
 * `then . end` 或 `end`、def 补 `;`）。任何环节失败都返回 null，调用方
 * 回退默认回车（语言配置里的正则缩进规则照常兜底）。
 */
import { tokenize, LexError, type Token } from './tokenizer'
import { formatJq, FormatError, type FormatOptions } from './formatter'

/**
 * 探针哨兵：格式化器从不改动 token 文本，哨兵在输出中的位置就是
 * 「下一个 token 的规范位置」。名字刻意避开 `$__loc__`（专用 token）。
 */
const SENTINEL = '$__jq_enter__'

/** 尾随时「哨兵＝右操作数／下一项」的运算符与分隔符（含 and/or 关键字） */
const OP_TAIL = new Set([
  '|',
  '//',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '|=',
  '//=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  ',',
  '?//',
  'and',
  'or'
])

const OPENER: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/** 未闭合构造（前缀扫描栈的条目） */
type Entry =
  | {
      kind: 'group'
      closer: string
      /** reduce／foreach 的行为组：元素间用 `;` 分隔、至少两个部分 */
      reduce: boolean
      /** `as` 之后紧跟的析构模式组：它闭合时 as 绑定完成 */
      pattern: boolean
      hasContent: boolean
      /** 开括号所在行的行首缩进（光标后是闭括号时的回退答案） */
      openerLineIndent: number
      /** 开括号所在行号（判定首元素是否与其同行＝悬挂形态） */
      openerLine: number
      /** 悬挂形态：首元素的实际列（续行对齐目标）。注意这偏离了格式化
       *  器的规范列（开括号列＋2，悬挂式会补内侧空格）—— 回车遵循
       *  「对齐眼前所见」，后续 format 再归一 */
      firstContentCol: number | null
    }
  | { kind: 'if'; col: number; phase: 'cond' | 'then' | 'else' }
  /** def：是否已过 `:`（补全时未过则需先补 `: 体` 再补 `;`） */
  | { kind: 'def'; bodyStarted: boolean }

interface Tail {
  entries: Entry[]
  last: Token
  asDone: boolean
  labelDone: boolean
}

/** token 能否收尾一个完整表达式（其后文法期望子句关键字或闭括号） */
function isComplete(t: Token): boolean {
  if (t.type === 'operator') {
    return (
      t.text === ')' ||
      t.text === ']' ||
      t.text === '}' ||
      t.text === '?' ||
      t.text === '.' ||
      t.text === '..'
    )
  }
  return (
    t.type === 'ident' ||
    t.type === 'variable' ||
    t.type === 'number' ||
    t.type === 'string' ||
    t.type === 'format' ||
    t.type === 'constant' ||
    (t.type === 'keyword' && t.text === 'end')
  )
}

/**
 * 扫描前缀实 token，维护未闭合构造栈与 as／label 绑定状态。括号不
 * 配对、子句关键字错位等残缺状态返回 null（回退默认回车，不去猜）。
 */
function scanTail(real: Token[]): Tail | null {
  const entries: Entry[] = []
  let asState: 'none' | 'await' | 'inPattern' | 'done' = 'none'
  let labelState: 'none' | 'await' | 'done' = 'none'
  let firstCol = real[0]!.col
  let prevLine = real[0]!.line
  for (const t of real) {
    if (t.line !== prevLine) {
      firstCol = t.col
      prevLine = t.line
    }
    const top = entries[entries.length - 1]
    if (top?.kind === 'group') {
      if (!top.hasContent) {
        top.firstContentCol = t.line === top.openerLine ? t.col : null
      }
      top.hasContent = true
    }
    const x = t.text
    if (t.type === 'operator') {
      if (OPENER[x] !== undefined) {
        const pattern: boolean = asState === 'await'
        entries.push({
          kind: 'group',
          closer: OPENER[x]!,
          reduce: asState === 'done',
          pattern,
          hasContent: false,
          openerLineIndent: firstCol,
          openerLine: t.line,
          firstContentCol: null
        })
        // reduce／foreach 的行为组消费掉绑定状态；`as [` 的模式组转入
        // inPattern，由它的闭合置 done
        asState = pattern ? 'inPattern' : 'none'
        continue
      }
      if (x === ')' || x === ']' || x === '}') {
        if (top?.kind !== 'group' || top.closer !== x) return null
        entries.pop()
        if (top.pattern) asState = 'done'
        continue
      }
      if (x === '|') {
        asState = 'none'
        labelState = 'none'
        continue
      }
      if (x === '?//') {
        if (asState === 'done') asState = 'await'
        continue
      }
      if (x === ';') {
        // def 的体结束符／import 的结束符；reduce 组内的部分分隔符不
        // 改变状态。`;` 之后的东西一律是「兄弟」—— 由分类层的通用
        // `;` 分支用哨兵扮演，这里无需记录刚弹出了什么
        if (top?.kind === 'def') entries.pop()
        continue
      }
      if (x === ':') {
        // def 头的冒号（对象条目的冒号在未闭合组内，不会走到这）
        if (top?.kind === 'def') top.bodyStarted = true
        continue
      }
      continue
    }
    if (t.type === 'keyword') {
      if (x === 'if') {
        entries.push({ kind: 'if', col: t.col, phase: 'cond' })
        continue
      }
      if (x === 'def') {
        entries.push({ kind: 'def', bodyStarted: false })
        continue
      }
      if (x === 'as') {
        asState = 'await'
        continue
      }
      if (x === 'label') {
        labelState = 'await'
        continue
      }
      if (x === 'then' || x === 'elif' || x === 'else') {
        if (top?.kind !== 'if') return null
        top.phase = x === 'then' ? 'then' : x === 'else' ? 'else' : 'cond'
        continue
      }
      if (x === 'end') {
        if (top?.kind !== 'if') return null
        entries.pop()
        continue
      }
      continue
    }
    if (t.type === 'variable') {
      if (asState === 'await') asState = 'done'
      else if (labelState === 'await') labelState = 'done'
      continue
    }
    // `as`／`label` 之后只能跟模式；其他 token（如 import 的标识符
    // 绑定名）说明这不是要补 `|` 的绑定
    if (asState === 'await') asState = 'none'
    if (labelState === 'await') labelState = 'none'
  }
  return {
    entries,
    last: real[real.length - 1]!,
    asDone: asState === 'done',
    labelDone: labelState === 'done'
  }
}

/** 自内向外闭合所有未闭合构造（探针的 POST 后缀） */
function closeAll(entries: Entry[]): string {
  let out = ''
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.kind === 'group') out += e.reduce && !e.hasContent ? `; .${e.closer}` : e.closer
    else if (e.kind === 'if') out += e.phase === 'cond' ? ' then . end' : ' end'
    else out += e.bodyStarted ? ';' : ': .;'
  }
  return out
}

/**
 * 构造探针并从格式化输出里读出答案。insert 是替换进光标处的完整文本
 * （必含哨兵），post 自内向外闭合未闭合构造。
 * mode：
 *  - 'sentinel'：光标后紧跟的就是内容 token，答案＝哨兵列（行首时即
 *    行首缩进；跟在行首运算符之后时即操作数列）；
 *  - 'operator'：文法要求先敲 `|`（as／label 绑定刚完成），答案＝哨兵
 *    行行首运算符的列。
 * offset：格式化器把整个程序归一到 0 列起步，输出列要加回文档的实际
 * 基准缩进（前缀首个实 token 所在行的缩进），列锚定（悬挂组对齐等）
 * 与行锚定的位置都随基准平移。
 */
function probe(
  prefix: string,
  insert: string,
  post: string,
  mode: 'sentinel' | 'operator',
  opts: FormatOptions,
  offset: number
): number | null {
  let sent = SENTINEL
  while (prefix.includes(sent)) sent += '_'
  const src = prefix + insert.replace(SENTINEL, sent) + post
  let out: string
  try {
    out = formatJq(src, opts)
  } catch (e) {
    if (e instanceof FormatError) return null
    throw e
  }
  const line = out.split('\n').find((l) => l.includes(sent))
  if (line === undefined) return null
  const col = mode === 'operator' ? line.length - line.trimStart().length : line.indexOf(sent)
  return col + offset
}

/**
 * 计算回车后新行的缩进（空格列数）。算不出（残缺输入、未支持形态）
 * 返回 null，调用方回退默认回车。cursor 必须落在某个实 token 所在行
 * 的行尾附近（空行上的回车由默认行为复制缩进）。
 */
export function enterIndent(src: string, cursor: number, opts: FormatOptions): number | null {
  const prefix = src.slice(0, cursor)
  if (prefix.trim() === '') return null
  let tokens: Token[]
  try {
    tokens = tokenize(prefix)
  } catch (e) {
    if (e instanceof LexError) return null
    throw e
  }
  const real = tokens.filter((t) => t.type !== 'comment')
  if (real.length === 0) return null
  const lastTok = tokens[tokens.length - 1]!
  const cursorLine = prefix.split('\n').length - 1
  if (lastTok.line !== cursorLine) return null
  if (lastTok.type === 'comment') return null

  const tail = scanTail(real)
  if (tail === null) return null
  const { entries, last, asDone, labelDone } = tail
  const top = entries[entries.length - 1]
  // 文档基准缩进：前缀首个实 token 所在行的行首缩进
  const offset = real[0]!.col
  // POST 前的断行迫使最内层组展开（join 分支会绕过子打印器，把条目
  // 内部的作者断行一并吞掉），闭括号换行不影响哨兵所在行的缩进
  const post = `\n${closeAll(entries)}`
  const ask = (insert: string, mode: 'sentinel' | 'operator'): number | null =>
    probe(prefix, insert, post, mode, opts, offset)
  /** 逗号类探针：断行放在分隔符之前。函数实参组把 `a, b` 解析成单个
   *  逗号节点，分隔符之后的断行不构成作者断行（组会被并回单行），
   *  分隔符之前才会；已有尾随逗号时从（虚拟的）前缀里摘掉重建 */
  const askComma = (): number | null => {
    const stripped = last.text === ',' ? prefix.replace(/,\s*$/, '') : prefix
    return probe(stripped, `\n, ${SENTINEL}`, post, 'sentinel', opts, offset)
  }

  // 光标后同行还有内容：新行将承接它们。只对「下一个 token 是闭括号
  // 或子句关键字」两种给出列对齐答案（这是正则做不到的），其余照常
  // 按前缀分类 —— 新行承接的是普通内容 token，位置同哨兵。
  const restLine = (src.slice(cursor).split('\n', 1)[0] ?? '').trim()
  if (restLine !== '') {
    if (/^[}\])]/.test(restLine)) {
      // 光标停在（多半是自动配全的）闭括号前：文法上还在等内容 →
      // 元素层（典型流程：敲 `{` 自动补 `}`，光标落在闭括号前继续写）；
      // 元素已完整、下一个只可能是 `,` 或闭括号 → 回基线层收括号
      const g = [...entries]
        .reverse()
        .find((e): e is Extract<Entry, { kind: 'group' }> => e.kind === 'group')
      if (g === undefined) return null
      const contentTail =
        OP_TAIL.has(last.text) ||
        (last.type === 'operator' && OPENER[last.text] !== undefined) ||
        (last.type === 'keyword' &&
          ['then', 'else', 'elif', 'catch', 'try', 'if'].includes(last.text)) ||
        (last.text === ':' && (top?.kind === 'def' || top?.kind === 'group')) ||
        (last.text === ';' && top?.kind === 'group' && top.reduce) ||
        asDone ||
        labelDone
      return contentTail
        ? (g.firstContentCol ?? g.openerLineIndent + opts.indentSize)
        : g.openerLineIndent
    }
    if (/^(else|elif|end)\b/.test(restLine)) {
      const f = [...entries]
        .reverse()
        .find((e): e is Extract<Entry, { kind: 'if' }> => e.kind === 'if')
      return f?.col ?? null
    }
  }

  // 悬挂组（首元素在开括号行上）的元素／条目续行对齐首元素实际列：
  // 紧贴 `{a:1,` 给 1、带空格 `{ a: 1,` 给 2 —— 对齐眼前所见（偏离
  // 格式化器规范列「开括号列＋2」，format 时再归一）
  if (last.text === ',') {
    if (top?.kind === 'group' && top.firstContentCol !== null) return top.firstContentCol
    return askComma()
  }
  if (OP_TAIL.has(last.text)) return ask(`\n${SENTINEL}`, 'sentinel')
  if (last.type === 'operator' && OPENER[last.text] !== undefined) {
    return ask(`\n${SENTINEL}`, 'sentinel')
  }
  if (
    last.type === 'keyword' &&
    ['then', 'else', 'elif', 'catch', 'try', 'if'].includes(last.text)
  ) {
    return ask(`\n${SENTINEL}`, 'sentinel')
  }
  // `:` ＝ def 体的开头（括号栈为空时的冒号只可能是 def 的）；对象／
  // 模式条目的 `:` 则在未闭合 `{` 组内 —— 哨兵＝值。悬挂组对齐首元素列
  if (last.text === ':' && top?.kind === 'group' && top.firstContentCol !== null) {
    return top.firstContentCol
  }
  if (last.text === ':' && (top?.kind === 'def' || top?.kind === 'group')) {
    return ask(`\n${SENTINEL}`, 'sentinel')
  }
  // reduce／foreach 组的部分分隔符：哨兵＝下一部分（悬挂组对齐首部分列）
  if (last.text === ';' && top?.kind === 'group' && top.reduce) {
    return top.firstContentCol ?? ask(`\n${SENTINEL}`, 'sentinel')
  }
  // 其余一切 `;`：结束 def／import，或组内参数分隔 —— 之后的东西一律
  // 是兄弟（顶层兄弟语句不缩进、组内兄弟项／兄弟参数取元素层），哨兵
  // 直接扮演它；悬挂组先对齐首元素实际列；解析不了（残缺代码）自然回退
  if (last.text === ';') {
    return top?.kind === 'group'
      ? (top.firstContentCol ?? ask(`\n${SENTINEL}`, 'sentinel'))
      : ask(`\n${SENTINEL}`, 'sentinel')
  }
  // as／label 绑定刚完成：文法要求 `|`，答案对齐到行首 `|` 的列
  if (asDone || labelDone) return ask(`|\n${SENTINEL}`, 'operator')
  if (isComplete(last)) {
    // 完整表达式收尾 + 未闭合 if：下一个 token 是 elif/else/end，
    // 回到 if 关键字列（行中 if 时是对齐列而非行缩进）
    if (top?.kind === 'if') return top.col
    // 组内完整元素：用户接着敲 `,` 或继续 —— 悬挂组对齐首元素列，
    // 分隔展开式走探针
    if (top?.kind === 'group' && !top.reduce) {
      return top.firstContentCol !== null ? top.firstContentCol : askComma()
    }
    return null
  }
  return null
}

interface EnterEdit {
  start: number
  end: number
  beforeCursor: string
  afterCursor: string
}

/** 回车编辑：空括号对展开为三行，其余情况沿用单次换行。 */
export function enterEdit(
  src: string,
  cursor: number,
  opts: FormatOptions,
  insertSpaces: boolean,
  tabSize: number
): EnterEdit | null {
  const cols = enterIndent(src, cursor, opts)
  if (cols === null) return null
  const indent = (width: number): string =>
    insertSpaces
      ? ' '.repeat(width)
      : '\t'.repeat(Math.floor(width / tabSize)) + ' '.repeat(width % tabSize)

  // enterIndent 已排除注释和未闭合的字符串；只有同行匹配的空括号才插入两次换行。
  const linePrefix = src.slice(src.lastIndexOf('\n', cursor - 1) + 1, cursor)
  const left = /([({\[])([ \t]*)$/.exec(linePrefix)
  const right = /^[ \t]*/.exec(src.slice(cursor))![0]
  if (left && OPENER[left[1]!] === src[cursor + right.length]) {
    const base = /^[ \t]*/.exec(linePrefix)![0]
    let baseCols = 0
    for (const ch of base) baseCols += ch === '\t' ? tabSize - (baseCols % tabSize) : 1
    return {
      start: cursor - left[2]!.length,
      end: cursor + right.length,
      beforeCursor: `\n${indent(baseCols + opts.indentSize)}`,
      afterCursor: `\n${base}`
    }
  }
  return { start: cursor, end: cursor, beforeCursor: `\n${indent(cols)}`, afterCursor: '' }
}
