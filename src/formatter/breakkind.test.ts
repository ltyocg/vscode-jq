import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize } from '../tokenizer'
import { breakAfter, breakBefore, isLineBreakBinop } from './breakkind'
import { buildStream, type TokenStream } from './tokens'

const stream = (src: string): TokenStream => buildStream(tokenize(src))

/** src 里每个 token 的 before 分类；比较时按 token 文本对齐 */
const beforeByText = (src: string, text: string): (string | null)[] => {
  const st = stream(src)
  return st.tokens.filter((t) => t.text === text).map((t) => breakBefore(st, st.tokens.indexOf(t)))
}

test('breakBefore classifies operator break points', () => {
  const st = stream('.a | .b + .c, [1]')
  const kinds = st.tokens.map((t) => breakBefore(st, st.tokens.indexOf(t)))
  assert.equal(kinds[st.tokens.findIndex((t) => t.text === '|')], 'pipe')
  assert.equal(kinds[st.tokens.findIndex((t) => t.text === '+')], 'binop')
  assert.equal(kinds[st.tokens.findIndex((t) => t.text === ',')], 'leadSep')
  assert.equal(kinds[st.tokens.findIndex((t) => t.text === '[')], null)
  assert.equal(kinds[st.tokens.findIndex((t) => t.text === ']')], 'closer')
})

test('unary minus is not a binop break point', () => {
  assert.equal(beforeByText('[-1, -2]', '-')[0], null)
  assert.equal(beforeByText('1 - 2', '-')[0], 'binop')
  assert.ok(isLineBreakBinop(stream('1 - 2').tokens[1]))
  assert.equal(isLineBreakBinop(stream('-1').tokens[0]), false)
})

test('breakBefore classifies clause and def keywords, object keys excluded', () => {
  const st = stream('if .a then .b else .c end')
  for (const kw of ['then', 'else', 'end']) {
    const k = st.tokens.findIndex((t) => t.text === kw)
    assert.equal(breakBefore(st, k), 'clause')
  }
  const st2 = stream('.x | def f: .a; f')
  assert.equal(
    breakBefore(
      st2,
      st2.tokens.findIndex((t) => t.text === 'def')
    ),
    'def'
  )
  // 文件首的 def 没有前置内容，不算断点
  const st3 = stream('def f: .a; f')
  assert.equal(breakBefore(st3, 0), null)
  // `{if: 1}` —— 对象键不是子句/def 断点
  const st4 = stream('{if: 1, def: 2}')
  assert.equal(
    breakBefore(
      st4,
      st4.tokens.findIndex((t) => t.text === 'if')
    ),
    null
  )
  assert.equal(
    breakBefore(
      st4,
      st4.tokens.findIndex((t) => t.text === 'def')
    ),
    null
  )
})

test('breakAfter classifies trigger tokens', () => {
  const st = stream('[1, {a: 1}]')
  assert.equal(
    breakAfter(
      st,
      st.tokens.findIndex((t) => t.text === '[')
    ),
    'afterOpener'
  )
  assert.equal(
    breakAfter(
      st,
      st.tokens.findIndex((t) => t.text === ',')
    ),
    'afterSep'
  )
  assert.equal(
    breakAfter(
      st,
      st.tokens.findIndex((t) => t.text === ':')
    ),
    'afterColon'
  )
  assert.equal(
    breakAfter(
      st,
      st.tokens.findIndex((t) => t.text === '1')
    ),
    null
  )

  const st2 = stream('if .a then .b else .c end')
  for (const kw of ['then', 'else', 'end']) {
    const k = st2.tokens.findIndex((t) => t.text === kw)
    assert.equal(breakAfter(st2, k), 'afterClause')
  }
  // 对象键关键字仍是 afterClause（decide/predict 两侧都不加对象键守卫）
  const st3 = stream('{then: 1}')
  assert.equal(
    breakAfter(
      st3,
      st3.tokens.findIndex((t) => t.text === 'then')
    ),
    'afterClause'
  )
})

test('breakBefore classifies the reduce/foreach group paren after an as pattern', () => {
  // '$var' 模式与 '[…]' 模式（含嵌套）之后的 '(' 都是 reduce 分组
  for (const src of [
    'reduce .[] as $x (0; . + $x)',
    'foreach .[] as $x (0; . + $x; .)',
    'reduce .[] as [$k, $v] (0; .)',
    'reduce .[] as [$k, [$v]] (0; .)'
  ]) {
    const st = stream(src)
    const k = st.tokens.findIndex((t, i) => t.text === '(' && i > 2)
    assert.equal(breakBefore(st, k), 'reduce', src)
  }
  // 普通调用/分组的 '(' 不是 reduce 断点；管道绑定 as 之后是 '|'
  for (const src of ['f(1)', '(.a as $x | $x)', 'reduce .[] as $x | f(1)']) {
    const st = stream(src)
    const k = st.tokens.findIndex((t) => t.text === '(')
    assert.notEqual(breakBefore(st, k), 'reduce', src)
  }
})

test('keyword binops and/or are break points, object keys excluded', () => {
  const st = stream('.a and .b or .c')
  assert.equal(
    breakBefore(
      st,
      st.tokens.findIndex((t) => t.text === 'and')
    ),
    'binop'
  )
  assert.equal(
    breakBefore(
      st,
      st.tokens.findIndex((t) => t.text === 'or')
    ),
    'binop'
  )
  assert.equal(
    breakAfter(
      st,
      st.tokens.findIndex((t) => t.text === 'and')
    ),
    'afterBinop'
  )
  assert.equal(
    breakAfter(
      st,
      st.tokens.findIndex((t) => t.text === 'or')
    ),
    'afterBinop'
  )
  // `{and: 1, or: 2}` —— 对象键不是双目断点
  const st2 = stream('{and: 1, or: 2}')
  assert.equal(
    breakBefore(
      st2,
      st2.tokens.findIndex((t) => t.text === 'and')
    ),
    null
  )
  assert.equal(
    breakAfter(
      st2,
      st2.tokens.findIndex((t) => t.text === 'or')
    ),
    null
  )
})

test('breakAfter classifies trailing-style binops and pipes', () => {
  const st = stream('.a | .b + .c // .d')
  assert.equal(
    breakAfter(
      st,
      st.tokens.findIndex((t) => t.text === '|')
    ),
    'afterBinop'
  )
  assert.equal(
    breakAfter(
      st,
      st.tokens.findIndex((t) => t.text === '+')
    ),
    'afterBinop'
  )
  assert.equal(
    breakAfter(
      st,
      st.tokens.findIndex((t) => t.text === '//')
    ),
    'afterBinop'
  )
  // 一元 '-' 之后不是断点；'?//' 不在行首双目之列
  assert.equal(breakAfter(stream('-1'), 0), null)
  const st2 = stream('.a as [$x] ?// $y | $x')
  assert.equal(
    breakAfter(
      st2,
      st2.tokens.findIndex((t) => t.text === '?//')
    ),
    null
  )
})
