/**
 * 解析器测试：
 *  1. 语料回归（testdata/test.jq，三千余行真实 jq）—— 解析成功且
 *     span 结构良构（父子包含、同级有序、起止都是实 token）；
 *  2. 产生式矩阵 —— 覆盖 jqlang 文法的全部产生式形态；
 *  3. 结构抽查 —— 链扁平化、as 绑定归属、try 结合度等关键形状；
 *  4. 拒绝矩阵 —— nonassoc 链、`. foo`、对象值中的 as 等非法输入。
 *
 * token 级的完整覆盖（发射顺序断言 + 重词法化等价）由打印器测试承担。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseProgram, ParseError } from './parse'
import type { Program } from './ast'

const parse = (src: string) => parseProgram(src).program

// ---- span 结构良构性检查（通用深优先遍历） -------------------------------

interface SpanCheck {
  start: number
  end: number
}

function isNodeLike(v: unknown): v is SpanCheck {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as SpanCheck).start === 'number' &&
    typeof (v as SpanCheck).end === 'number'
  )
}

/** 断言：每个节点的起止是实 token；子节点包含于父节点；数组同级有序不重叠 */
function checkSpans(program: Program, tokens: { type: string }[]): void {
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      let prevEnd = -1
      for (let i = 0; i < node.length; i++) {
        const item: unknown = node[i]
        if (isNodeLike(item)) {
          assert.ok(
            item.start >= prevEnd,
            `${path}[${i}]: sibling overlap (start ${item.start} < prev end ${prevEnd})`
          )
          prevEnd = item.end
        }
        visit(item, `${path}[${i}]`)
      }
      return
    }
    if (typeof node !== 'object' || node === null) return
    assert.ok(
      !isNodeLike(node) || path === 'program' || node.start < node.end,
      `${path}: empty span`
    )
    for (const [key, value] of Object.entries(node)) {
      if (isNodeLike(value)) {
        if (isNodeLike(node)) {
          assert.ok(
            value.start >= node.start,
            `${path}.${key}: child start ${value.start} < node start ${node.start}`
          )
          assert.ok(
            value.end <= node.end,
            `${path}.${key}: child end ${value.end} > node end ${node.end}`
          )
        }
      }
      visit(value, `${path}.${key}`)
    }
  }
  visit(program, 'program')
  // 起止 token 都是实 token
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (typeof node !== 'object' || node === null) return
    if (isNodeLike(node) && node.end > node.start) {
      assert.ok(
        tokens[node.start] !== undefined && tokens[node.start].type !== 'comment',
        'span 起点必须是实 token'
      )
      assert.ok(
        tokens[node.end - 1] !== undefined && tokens[node.end - 1].type !== 'comment',
        'span 终点必须是实 token'
      )
    }
    Object.values(node).forEach(walk)
  }
  walk(program)
}

function parseAndCheck(src: string): Program {
  const r = parseProgram(src)
  checkSpans(r.program, r.tokens)
  return r.program
}

// ---- 1. 语料回归 ---------------------------------------------------------

test('parses the jqjq corpus with well-formed spans', () => {
  const root = join(__dirname, '..', '..', '..')
  const src = readFileSync(join(root, 'testdata', 'test.jq'), 'utf8')
  parseAndCheck(src.replace(/\r\n/g, '\n'))
})

// ---- 2. 产生式矩阵 -------------------------------------------------------

test('grammar matrix: every production parses with well-formed spans', () => {
  const samples = [
    // 双目运算符全族
    '.a // .b',
    '.a = .b | .a |= .b',
    '.a += .b',
    '.a -= .b',
    '.a *= .b',
    '.a /= .b',
    '.a %= .b',
    '.a //= .b',
    'true or false and null',
    '.a == .b, .c != .d',
    '1 < 2, 3 <= 4, 5 > 6, 7 >= 8',
    '1 + 2 - 3 * 4 / 5 % 6',
    // ?// 析构备选
    '. as [$a, $b] ?// {$c} ?// $d | .',
    '. as {a: [$x, {b: $y}]} | .',
    '. as {$a, "s": $b, ({"k"} | .): $c} | .',
    // foreach 含 extract
    'foreach .[] as $x (0; . + $x; . * 2)',
    // 关键字作对象键
    '{if: 1, end: 2, and: 3, then: 4, as: 5, def: 6}',
    '{$var: 1, $shorthand, ident, "str", (1 + 2): 3, if: 9, true: 10}',
    '{a: 1,}',
    // 点号字段名与邻接守护
    '.catch',
    '$if_.then',
    'if . then . else . end',
    'try . catch .',
    '.a.catch.end',
    // 递归 / 可选 / 后缀
    '.. | .a?',
    '.a[0][]?',
    'first(.[])?',
    '(.f).g',
    '."quoted"',
    '. "spaced-string"',
    '.a. "b"',
    // 切片
    '.[2:5]',
    '.[a:]',
    '.[:b]',
    '.[a:b]',
    '.a[1:-1]',
    // 格式串
    '@base64',
    '@base64 "x"',
    '@text "\\(1 + 2)"',
    // def 形态
    'def f: .;',
    'def f(a; b): .;',
    'def f($a; b): .;',
    'def a::b: .; a::b',
    'def f: def g: .; g; f',
    '.x as $v | def f: .a; f',
    '[.x as $v | def f: .a; f]',
    // label / break
    'label $out | break $out',
    'first(label $out | .[] | ., break $out)',
    // import / include / module
    'module {a: 1}; import "x" as y {b: 2}; include "z"; .',
    'import "x" as $y; .',
    // 对象值管道
    '{a: .b | .c}',
    '{a: .b | .c | .d}',
    // 一元
    '-1 + 2',
    '2 * -1',
    '-.a.b',
    '- -1',
    // $$$ 名字
    '$$$$x',
    // 字符串插值与多行字符串（原样保留）
    '"a \\(1 + 2) b"',
    'def src: "\ndef f: .a;\n.def";\nsrc',
    // reduce
    'reduce .[] as $x (0; . + $x)',
    'reduce (1, 2) as $x (. + $x; .)',
    // as 的 head 是完整 Expr
    '.a + .b as $x | $x',
    'try f as $x | $x',
    // try 结合度（body 是 Term）
    'try error catch .',
    'try .a[0]',
    'try (a, b)',
    'try f.a',
    // 嵌套
    '[[1, 2], {a: [3]}]',
    'if .a then if .b then 1 else 2 end elif .c then 3 else 4 end',
    '(1 | 2) + (3, 4 | .)',
    // 空文件 / 纯注释
    '',
    '# only a comment'
  ]
  for (const src of samples) parseAndCheck(src)
})

// ---- 3. 结构抽查 ---------------------------------------------------------

/** 顶层表达式的 Expr（Program.body → ExprQuery.expr） */
function bodyExpr(src: string): ReturnType<typeof parse>['body'] {
  return parse(src).body
}

test('structure: pipe flattening and as attachment', () => {
  const p1 = bodyExpr('.a | .b, .c | .d')
  assert.ok(p1 && p1.kind === 'pipe')
  if (p1 && p1.kind === 'pipe') {
    assert.equal(p1.segments.length, 3)
    assert.ok(p1.segments[1].head.kind === 'comma')
  }

  const p2 = bodyExpr('.a, .b as $x | $x')
  assert.ok(p2 && p2.kind === 'comma')
  if (p2 && p2.kind === 'comma') {
    assert.equal(p2.items.length, 2)
    const item = p2.items[1]!
    assert.ok(item.head !== null && item.head.kind === 'as')
  }

  const p3 = bodyExpr('.a as $x | .b | .c')
  assert.ok(p3 && p3.kind === 'as')
  if (p3 && p3.kind === 'as') {
    // as 的 body 吞掉剩余管道
    assert.ok(p3.body.kind === 'pipe')
  }
})

test('structure: chain flattening per precedence tier', () => {
  // a + b * c → 加法链，乘法在操作数里
  const q = bodyExpr('a + b * c')
  assert.ok(q && q.kind === 'expr')
  if (q && q.kind === 'expr') {
    const e = q.expr
    assert.equal(e.kind, 'chain')
    if (e.kind === 'chain') {
      assert.equal(e.links.length, 1)
      assert.equal(e.links[0].operand.kind, 'chain') // b * c
    }
  }
})

test('structure: try body is a single term', () => {
  // (try a) + b：加法链在 try 外面
  const q = bodyExpr('try a + b')
  assert.ok(q && q.kind === 'expr')
  if (q && q.kind === 'expr') {
    assert.equal(q.expr.kind, 'chain')
  }
})

test('structure: dot-keyword adjacency', () => {
  // .catch 是字段访问
  const q1 = bodyExpr('.catch')
  assert.ok(q1 && q1.kind === 'expr')
  if (q1 && q1.kind === 'expr' && q1.expr.kind === 'term') {
    assert.equal(q1.expr.term.inner.kind, 'field')
  }

  // `if . then` 的 `.` 是身份
  const q2 = bodyExpr('if . then 1 else 2 end')
  assert.ok(q2 && q2.kind === 'expr')
  if (q2 && q2.kind === 'expr' && q2.expr.kind === 'term' && q2.expr.term.inner.kind === 'if') {
    const cond = q2.expr.term.inner.clauses[0]!.cond
    assert.ok(cond.kind === 'expr')
    if (cond.kind === 'expr') {
      assert.ok(cond.expr.kind === 'term')
      if (cond.expr.kind === 'term') assert.equal(cond.expr.term.inner.kind, 'identity')
    }
  }
})

// ---- 4. 拒绝矩阵 ---------------------------------------------------------

test('rejects invalid jq', () => {
  const invalid = [
    'a = b = c', // nonassoc 赋值链
    'a < b < c', // nonassoc 比较链
    '. foo', // 字段访问要求邻接
    'try f . catch g', // 后缀位置的 `.` 后不是字段
    '{a: .x as $v | $v}', // 对象值不能含 as（jq 要求括号）
    '(1', // 括号不平衡
    '[1,]', // 数组不允许尾逗号
    'if .a then 1', // 缺 end
    'def f .;', // 缺冒号
    'a |', // 悬空管道
    '. as $x' // 缺 |
  ]
  for (const src of invalid) {
    assert.throws(() => parseProgram(src), ParseError, `should reject: ${src}`)
  }
})
