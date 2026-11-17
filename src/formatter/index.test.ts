import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatJq, FormatError } from './index'

const fmt = (src: string, printWidth = 100) => formatJq(src, { printWidth })

test('normalizes spacing around operators', () => {
  assert.equal(fmt('.a|.b'), '.a | .b\n')
  assert.equal(fmt('.a  +   .b'), '.a + .b\n')
  assert.equal(fmt('1==2'), '1 == 2\n')
  assert.equal(fmt('.a // .b'), '.a // .b\n')
  assert.equal(fmt('.x as $v|$v'), '.x as $v | $v\n')
})

test('field access and indexing stay tight', () => {
  assert.equal(fmt('.a.b.c'), '.a.b.c\n')
  assert.equal(fmt('.a [ 0 ]'), '.a[0]\n')
  assert.equal(fmt('.["foo"]'), '.["foo"]\n')
  assert.equal(fmt('."foo"'), '."foo"\n')
  assert.equal(fmt('.a[]?'), '.a[]?\n')
  assert.equal(fmt('first[0]'), 'first[0]\n')
  assert.equal(fmt('$x.y'), '$x.y\n')
  assert.equal(fmt('map(.a)'), 'map(.a)\n')
})

test('unary minus', () => {
  assert.equal(fmt('{a: -1}'), '{a: -1}\n')
  assert.equal(fmt('[-1, -2]'), '[-1, -2]\n')
  assert.equal(fmt('f(-1)'), 'f(-1)\n')
  assert.equal(fmt('1 - 2'), '1 - 2\n')
  assert.equal(fmt('.[1:-1]'), '.[1:-1]\n')
  assert.equal(fmt('.[2:5]'), '.[2:5]\n')
})

test('literals, variables, formats, constants', () => {
  assert.equal(fmt('$__loc__'), '$__loc__\n')
  assert.equal(fmt('@base64 "x"'), '@base64 "x"\n')
  assert.equal(fmt('true and false or null'), 'true and false or null\n')
  assert.equal(fmt('1.5e10'), '1.5e10\n')
})

test('string interpolation kept verbatim', () => {
  const src = '"a \\(1 + 2) b"'
  assert.equal(fmt(src), src + '\n')
})

test('multi-line string literals (real lexer allows raw newlines)', () => {
  // jqlang/jq src/lexer.l 的 IN_QQSTRING 内容规则 `[^\\"]+` 能匹配
  // 换行 —— jqjq 的 _builtins_src 依赖这一点。内容原样保留。
  const src = 'def src: "\ndef f: .a;\n.def";\nsrc'
  assert.equal(fmt(src), src + '\n')
  // 插值体同样可以跨行
  assert.equal(fmt('"x \\(1 +\n2) y"'), '"x \\(1 +\n2) y"\n')
})

test('def formatting', () => {
  assert.equal(fmt('def f(a;b):.a|f;'), 'def f(a; b): .a | f;\n')
  assert.equal(fmt('def f: .a | .b; .f'), 'def f: .a | .b;\n.f\n')
  // def 之间的空行保留(最多一个)
  assert.equal(fmt('def f: .a;\n\n\ndef g: .b;\n.f'), 'def f: .a;\n\ndef g: .b;\n.f\n')
  // ……当上文是注释块且这是文件首个代码 token 时也一样
  // (jqjq.jq 的文件头)
  assert.equal(
    fmt('# shebang block\n# notes\n\ndef f: .a;\n.f'),
    '# shebang block\n# notes\n\ndef f: .a;\n.f\n'
  )
  // 源码没有空行:不凭空造出
  assert.equal(fmt('# c\ndef f: .a;\n.f'), '# c\ndef f: .a;\n.f\n')
})

test('if/elif/else/end clauses', () => {
  assert.equal(fmt('if .a then .b else .c end'), 'if .a then .b else .c end\n')
  const src = ['if .a', 'then .b', 'elif .c', 'then .d', 'else .e', 'end'].join('\n')
  assert.equal(fmt(src), src + '\n')
})

test('try/catch', () => {
  assert.equal(fmt('try .a catch .b'), 'try .a catch .b\n')
  const src = 'try .a\ncatch .b'
  assert.equal(fmt(src), 'try .a\ncatch .b\n')
})

test('reduce / foreach / label / break', () => {
  assert.equal(fmt('reduce .[] as $x (0; . + $x)'), 'reduce .[] as $x (0; . + $x)\n')
  assert.equal(
    fmt('foreach .[] as $x (0; . + $x; . * 2)'),
    'foreach .[] as $x (0; . + $x; . * 2)\n'
  )
  assert.equal(
    fmt('label $out | .[] | if . then . else break $out end'),
    'label $out | .[] | if . then . else break $out end\n'
  )
  assert.equal(fmt('. as [$a] ?// {$b} | $a'), '. as [$a] ?// {$b} | $a\n')
})

test('object construction', () => {
  assert.equal(fmt('{a: 1, "b": 2, $c}'), '{a: 1, "b": 2, $c}\n')
  assert.equal(fmt('{if: 1, end: 2}'), '{if: 1, end: 2}\n')
  const src = '{\n  "a": 1,\n  "b": 2\n}'
  assert.equal(fmt(src), src + '\n')
  // 注释迫使展开
  assert.equal(fmt('{a: 1, # first\nb: 2}'), '{\n  a: 1,  # first\n  b: 2\n}\n')
})

test('keyword-named object keys do not trigger clause logic', () => {
  // 形如子句/def 关键字的对象键必须保持单行,且不得开关 if/try
  // 上下文、不得被当作定义
  assert.equal(
    fmt('{if: 1, then: 2, else: 3, end: 4, catch: 5, try: 6, def: 7}'),
    '{if: 1, then: 2, else: 3, end: 4, catch: 5, try: 6, def: 7}\n'
  )
  // 对象键不得捕获或弹掉真实 if 的子句缩进
  const src = 'if .a\nthen {if: 1, end: 2}\nelse .b\nend'
  assert.equal(fmt(src), src + '\n')
  // jqjq 的形态:括号组内的关键字键(此前逗号从前导挪到尾导时
  // 反复格式化结果不稳定)
  const src2 = [
    'def f:',
    '  ( { cond: 1',
    '    , then: 2',
    '    , else: 3',
    '    }',
    '    | if .x then .y else . end',
    '  );',
    'f'
  ].join('\n')
  const once = fmt(src2)
  assert.equal(fmt(once), once, 'not idempotent for jqjq-like object keys')
})

test('import / include / module', () => {
  assert.equal(
    fmt('module {name: "x"}; import "a" as b; include "c"; .'),
    'module {name: "x"};\nimport "a" as b;\ninclude "c";\n.\n'
  )
})

test('pipeline breaks with leading pipe when too long', () => {
  const out = fmt('.aaaaaaaaaaaa | .bbbbbbbbbbbb | .cccccccccccc', 20)
  assert.equal(out, '.aaaaaaaaaaaa\n  | .bbbbbbbbbbbb\n  | .cccccccccccc\n')
})

test('source line breaks in pipelines are preserved', () => {
  assert.equal(fmt('.a\n| .b'), '.a\n  | .b\n')
})

test('groups expand when they do not fit', () => {
  const src = '{"aaaaaaaaaa": 1, "bbbbbbbbbb": 2, "cccccccccc": 3}'
  const out = fmt(src, 40)
  assert.equal(out, '{\n  "aaaaaaaaaa": 1,\n  "bbbbbbbbbb": 2,\n  "cccccccccc": 3\n}\n')
})

test('expanded paren groups (reduce)', () => {
  const src = 'reduce .[] as $x (\n  0;\n  . + $x\n)'
  assert.equal(fmt(src), src + '\n')
})

test('comments', () => {
  assert.equal(fmt('# header\n.a # trailing\n'), '# header\n.a  # trailing\n')
  assert.equal(fmt('.a | # note\n.b'), '.a |  # note\n  .b\n')
})

test('comment backslash continuation (jq 1.8 spec)', () => {
  // 行尾是奇数个反斜杠:下一行属于注释,原样保留、绝不重排缩进
  assert.equal(fmt('[.[]] # c \\\n, 99 is comment'), '[.[]]  # c \\\n, 99 is comment\n')
  // 偶数个:下一行是代码,正常格式化
  assert.equal(fmt('1, # even \\\\\n2'), '1,  # even \\\\\n2\n')
  // 独立的续行注释
  assert.equal(fmt('# a \\\ncont line\n. as $x | $x'), '# a \\\ncont line\n. as $x | $x\n')
  // jq 里反斜杠后跟空格不算续行;这个空格必须在格式化后保留,
  // 下一行才仍然是代码
  assert.equal(fmt('2 # c \\ \n+ 3'), '2  # c \\ \n+ 3\n')
})

test('leading-dot number literals', () => {
  assert.equal(fmt('.5+.5e2'), '.5 + .5e2\n')
  assert.equal(fmt('[.5, .25]'), '[.5, .25]\n')
  assert.equal(fmt('{a: .5}'), '{a: .5}\n')
  assert.equal(fmt('-.5'), '-.5\n')
  // 点访问仍然是点访问
  assert.equal(fmt('.a[0] | .[]'), '.a[0] | .[]\n')
})

test('group opened on a pipe-continuation line indents from that line', () => {
  // 开括号落在 '| …' 续行(缩进 1)上的组,内容比该行再深一层,
  // 闭括号回到该行的层级。
  assert.equal(fmt('.a\n| map({\n  b: 1\n})'), '.a\n  | map(\n    {\n      b: 1\n    }\n  )\n')
  assert.equal(fmt('.a\n| {\n  b: 1\n}'), '.a\n  | {\n    b: 1\n  }\n')
})

test('idempotency', () => {
  const samples = [
    'def f(a;b):.a|f;\n.x as $v|$v|f(1;2)',
    '{a:1,b:[1,2,3]}\n| .a',
    'if .a then .b else .c end',
    'reduce .[] as $x (0; . + $x)',
    '# c\n.foo | .bar # d\n| .baz',
    'try (.a | .b) catch ("err: \\(.)")',
    'label $out | foreach .[] as $x (0; .+1; if . > 3 then break $out else . end)',
    '# a \\\ncont\n. as $x | $x',
    '[.[]] # c \\\n, 99 is comment',
    '.5 + .5e2 + 1.5',
    'def src: "\na\nb";\nsrc | .x'
  ]
  for (const s of samples) {
    const once = fmt(s)
    assert.equal(fmt(once), once, `not idempotent for: ${s}`)
  }
})

test('broken input is left alone', () => {
  const bad = '{"a": 1' // 括号不配对
  assert.throws(() => fmt(bad), FormatError)
  assert.throws(() => fmt('.a "unterminated'), FormatError)
})

test('CRLF is preserved', () => {
  assert.equal(fmt('.a | .b\r\n'), '.a | .b\r\n')
})

test('empty input', () => {
  assert.equal(fmt(''), '')
  assert.equal(fmt('   \n\t\n'), '   \n\t\n')
})
