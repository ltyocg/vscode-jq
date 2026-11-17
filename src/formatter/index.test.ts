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
  assert.equal(fmt('{a: -1}'), '{ a: -1 }\n')
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
  // def 之间的空行原样保留（最多两个）
  assert.equal(fmt('def f: .a;\n\ndef g: .b;\n.f'), 'def f: .a;\n\ndef g: .b;\n.f\n')
  assert.equal(fmt('def f: .a;\n\n\ndef g: .b;\n.f'), 'def f: .a;\n\n\ndef g: .b;\n.f\n')
  // ……当上文是注释块且这是文件首个代码 token 时也一样
  // （jqjq.jq 的文件头）
  assert.equal(
    fmt('# shebang block\n# notes\n\ndef f: .a;\n.f'),
    '# shebang block\n# notes\n\ndef f: .a;\n.f\n'
  )
  // 源码没有空行：不凭空造出
  assert.equal(fmt('# c\ndef f: .a;\n.f'), '# c\ndef f: .a;\n.f\n')
  // 注释自身占的行不计成空行
  assert.equal(fmt('def f: .a;\n# c\ndef g: .b;'), 'def f: .a;\n# c\ndef g: .b;\n')
})

test('blank lines: preserved verbatim, never added, capped at two', () => {
  // 管道之间
  assert.equal(fmt('.a\n\n| .b'), '.a\n\n  | .b\n')
  // 连续两个以上空行压缩到两个
  assert.equal(fmt('.a\n\n\n\n| .b'), '.a\n\n\n  | .b\n')
  // 子句之间
  assert.equal(fmt('if .a\n\nthen .b else .c end'), 'if .a\n\nthen .b else .c end\n')
  // 展开组元素之间
  const arr = '[\n  1,\n\n  2\n]'
  assert.equal(fmt(arr), arr + '\n')
  // 独立注释前后
  const commented = '.a\n\n# note\n\n.b | .c'
  assert.equal(fmt(commented), commented + '\n')
  // 注释之间的空行
  assert.equal(fmt('# a\n\n# b\n.c'), '# a\n\n# b\n.c\n')
  // 行尾注释之后的空行
  assert.equal(fmt('.a # c\n\n| .b'), '.a # c\n\n  | .b\n')
  // 源码没有空行：行宽断行也不凭空增加
  assert.equal(fmt('.aaaaaaaa | .bbbbbbbb', 10), '.aaaaaaaa\n  | .bbbbbbbb\n')
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
  assert.equal(fmt('. as [$a] ?// {$b} | $a'), '. as [$a] ?// { $b } | $a\n')
})

test('object construction', () => {
  assert.equal(fmt('{a: 1, "b": 2, $c}'), '{ a: 1, "b": 2, $c }\n')
  assert.equal(fmt('{if: 1, end: 2}'), '{ if: 1, end: 2 }\n')
  const src = '{\n  "a": 1,\n  "b": 2\n}'
  assert.equal(fmt(src), src + '\n')
  // 注释迫使展开；开括号后接了内容 → 悬挂式，保留源码换行
  assert.equal(fmt('{a: 1, # first\nb: 2}'), '{ a: 1, # first\n  b: 2 }\n')
})

test('keyword-named object keys do not trigger clause logic', () => {
  // 形如子句/def 关键字的对象键必须保持单行，且不得开关 if/try
  // 上下文、不得被当作定义
  assert.equal(
    fmt('{if: 1, then: 2, else: 3, end: 4, catch: 5, try: 6, def: 7}'),
    '{ if: 1, then: 2, else: 3, end: 4, catch: 5, try: 6, def: 7 }\n'
  )
  // 对象键不得捕获或弹掉真实 if 的子句缩进
  const src = 'if .a\nthen { if: 1, end: 2 }\nelse .b\nend'
  assert.equal(fmt(src), src + '\n')
  // jqjq 的形态：括号组内的关键字键(此前逗号从前导挪到尾导时
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
    'module { name: "x" };\nimport "a" as b;\ninclude "c";\n.\n'
  )
})

test('pipeline breaks with leading pipe when too long', () => {
  const out = fmt('.aaaaaaaaaaaa | .bbbbbbbbbbbb | .cccccccccccc', 20)
  assert.equal(out, '.aaaaaaaaaaaa\n  | .bbbbbbbbbbbb\n  | .cccccccccccc\n')
})

test('source line breaks in pipelines are preserved', () => {
  assert.equal(fmt('.a\n| .b'), '.a\n  | .b\n')
})

test('binary operators break with leading operator', () => {
  // 超宽：在运算符前折行，运算符放行首、与本行同层
  const wide = '"aaaaaaaaaaaaaaaaaaaaaaaaaa" + "bbbbbbbbbbbbbbbbbbbbbbbbbb" + "ccccccccccccccccccc"'
  assert.equal(
    fmt(wide, 40),
    '"aaaaaaaaaaaaaaaaaaaaaaaaaa"\n+ "bbbbbbbbbbbbbbbbbbbbbbbbbb"\n+ "ccccccccccccccccccc"\n'
  )
  // 源码有换行：原样保留，行首运算符与开括号同列；悬挂组内侧补空格
  const src = '("aaa"\n+ "bbb"\n+ "ccc"\n);'
  assert.equal(fmt(src), '( "aaa"\n+ "bbb"\n+ "ccc"\n);\n')
  // 一元负号不是断点
  assert.equal(fmt('[-1, -2]'), '[-1, -2]\n')
  assert.equal(fmt('.[1:-1]'), '.[1:-1]\n')
  // 行内放得下：不断行
  assert.equal(fmt('.a + .b | .c'), '.a + .b | .c\n')
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

test('hanging groups: opener followed by content keeps source breaks', () => {
  // 开括号后接了内容：不强制断行，源码换行原样保留，内侧补一个空格
  assert.equal(fmt('reduce .[] as $x (0;\n  . + $x)'), 'reduce .[] as $x ( 0;\n  . + $x )\n')
  assert.equal(fmt('[1,\n  2,\n  3]'), '[ 1,\n  2,\n  3 ]\n')
  assert.equal(fmt('{a: 1,\n  b: 2}'), '{ a: 1,\n  b: 2 }\n')
  // 闭括号在源码里换行：回到开括号所在行的层级
  assert.equal(fmt('[1,\n  2\n]'), '[ 1,\n  2\n]\n')
  // 组内换行只发生在源码换过的地方
  assert.equal(fmt('[1, 2,\n  3]'), '[ 1, 2,\n  3 ]\n')
  // 开括号后没接内容：分隔式，每元素一行（内侧不补空格）
  assert.equal(fmt('[\n  1,\n  2\n]'), '[\n  1,\n  2\n]\n')
  // 悬挂组内续行会超宽：在分隔符处补断
  const wide = '[0, 1, ' + '2'.repeat(98) + ',\n  3]'
  assert.equal(fmt(wide), '[ 0, 1,\n  ' + '2'.repeat(98) + ',\n  3 ]\n')
  // 首个元素放不进开括号行：退回分隔式
  const huge = '[ ' + 'x'.repeat(100) + ',\n  2]'
  assert.equal(fmt(huge), '[\n  ' + 'x'.repeat(100) + ',\n  2\n]\n')
  // 悬挂组内的独立注释
  assert.equal(fmt('[1,\n# note\n2]'), '[ 1,\n  # note\n  2 ]\n')
})

test('single-line object literals pad one space inside braces', () => {
  // 只有大括号：内侧恰好一个空格
  assert.equal(fmt('{a: 1}'), '{ a: 1 }\n')
  assert.equal(fmt('{  a: 1  }'), '{ a: 1 }\n') // 不能多
  assert.equal(fmt('{a:1}'), '{ a: 1 }\n') // 不能少
  // 嵌套大括号各自补
  assert.equal(fmt('{a: {b: 1}}'), '{ a: { b: 1 } }\n')
  // 其余括号一律不补
  assert.equal(fmt('[1, 2, 3]'), '[1, 2, 3]\n')
  assert.equal(fmt('map( .a )'), 'map(.a)\n')
  assert.equal(fmt('f(  1  )'), 'f(1)\n')
  assert.equal(fmt('reduce .[] as $x (0; . + $x)'), 'reduce .[] as $x (0; . + $x)\n')
  assert.equal(fmt('.a[0] | .["k"]'), '.a[0] | .["k"]\n')
  // 空组不补
  assert.equal(fmt('{}'), '{}\n')
  assert.equal(fmt('map([])'), 'map([])\n')
  // 悬挂式展开组（开括号后接内容）：各种括号都补
  assert.equal(fmt('{a: 1,\n  b: 2}'), '{ a: 1,\n  b: 2 }\n')
  assert.equal(fmt('[1,\n  2]'), '[ 1,\n  2 ]\n')
  assert.equal(fmt('reduce .[] as $x (0;\n  . + $x)'), 'reduce .[] as $x ( 0;\n  . + $x )\n')
  // 分隔式展开组（开括号独占行）不补
  assert.equal(fmt('[\n  1\n]'), '[\n  1\n]\n')
  // 组内 def 不再强制断行，保持单行
  assert.equal(fmt('(def f: .a; f)'), '(def f: .a; f)\n')
})

test('comments', () => {
  assert.equal(fmt('# header\n.a # trailing\n'), '# header\n.a # trailing\n')
  assert.equal(fmt('.a | # note\n.b'), '.a | # note\n  .b\n')
  // 行尾注释间距：不足一个空格补一个，其余按源码原样保留
  assert.equal(fmt('.a# tight'), '.a # tight\n')
  assert.equal(fmt('.a    # wide'), '.a    # wide\n')
  // 代码被重新排版后，注释间距仍以源码为准
  assert.equal(fmt('1  +  2   # c'), '1 + 2   # c\n')
})

test('comment backslash continuation (jq 1.8 spec)', () => {
  // 行尾是奇数个反斜杠：下一行属于注释，原样保留、绝不重排缩进
  assert.equal(fmt('[.[]] # c \\\n, 99 is comment'), '[.[]] # c \\\n, 99 is comment\n')
  // 偶数个：下一行是代码，正常格式化
  assert.equal(fmt('1, # even \\\\\n2'), '1, # even \\\\\n2\n')
  // 独立的续行注释
  assert.equal(fmt('# a \\\ncont line\n. as $x | $x'), '# a \\\ncont line\n. as $x | $x\n')
  // jq 里反斜杠后跟空格不算续行；这个空格必须在格式化后保留，
  // 下一行才仍然是代码
  assert.equal(fmt('2 # c \\ \n+ 3'), '2 # c \\ \n+ 3\n')
})

test('leading-dot number literals', () => {
  assert.equal(fmt('.5+.5e2'), '.5 + .5e2\n')
  assert.equal(fmt('[.5, .25]'), '[.5, .25]\n')
  assert.equal(fmt('{a: .5}'), '{ a: .5 }\n')
  assert.equal(fmt('-.5'), '-.5\n')
  // 点访问仍然是点访问
  assert.equal(fmt('.a[0] | .[]'), '.a[0] | .[]\n')
})

test('group opened on a pipe-continuation line indents from that line', () => {
  // 开括号落在 '| …' 续行（缩进 1）上的组，内容比该行再深一层，
  // 闭括号回到该行的层级。map( 后接了内容 → 悬挂式，内侧补空格。
  assert.equal(fmt('.a\n| map({\n  b: 1\n})'), '.a\n  | map( {\n    b: 1\n  } )\n')
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
    'def src: "\na\nb";\nsrc | .x',
    'def f: .a;\n\n\n\ndef g: .b;\n.f',
    '.a\n\n# note\n\n| .b',
    '[\n  1,\n\n  2\n]',
    'reduce .[] as $x (0;\n  . + $x)',
    '[1, 2,\n  3]',
    '[1,\n  2\n]'
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
