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

test('source break before def inside a group is not folded away', () => {
  // 回归：groupBreaks 只在「未换行」分支计入「展开组内的 def 总会
  // 断行」，源码恰好也在 def 之前换行时，组被误判成单行，def 被折叠
  // 进行中。两种源码形态必须给出同一结果。
  const out = '[ .x as $v |\n  def f: .a; f ]\n'
  assert.equal(fmt('[.x as $v |\ndef f: .a; f]'), out)
  assert.equal(fmt('[.x\nas $v | def f: .a; f]'), out)
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

test('if condition wraps under the if keyword', () => {
  // 条件的折行内容（尾随运算符的操作数、行首运算符）锚到 if 关键字
  // 列 +1 层，与分支体同层 —— 属于 if 层级，不挂到外层括号组的
  // 运算符链上；then/else/end 仍对齐 if
  assert.equal(
    fmt(
      '( $p[0] as $p0\n| if (type == "object") or\n      (type == "array") then\n    .x\n  else .y\n  end\n)'
    ),
    '( $p[0] as $p0\n| if (type == "object") or\n    (type == "array") then\n    .x\n  else .y\n  end\n)\n'
  )
  assert.equal(
    fmt(
      '( $p[0] as $p0\n| if (type == "object")\n      or (type == "array") then\n  else .y\n  end\n)'
    ),
    '( $p[0] as $p0\n| if (type == "object")\n    or (type == "array") then\n  else .y\n  end\n)\n'
  )
})

test('dot field names are not clause keywords', () => {
  // '.end'、'$if_.elif' 是字段访问，不触发子句记账：else/end 对齐 if
  const src = '( $l\n| if $l.ok then .x\n  elif $l.end then .end = true\n  else .\n  end\n)'
  assert.equal(fmt(src), src + '\n')
})

test('try/catch', () => {
  assert.equal(fmt('try .a catch .b'), 'try .a catch .b\n')
  const src = 'try .a\ncatch .b'
  assert.equal(fmt(src), 'try .a\ncatch .b\n')
  // 源码在 try 之后换行：body 另起一行，比 try 所在层深一层；catch
  // 仍与 try 对齐；body 里的 if/else/end 照常工作
  assert.equal(fmt('try\n  (lex | parse)'), 'try\n  (lex | parse)\n')
  assert.equal(fmt('try\n  (lex | parse)\ncatch\n  .'), 'try\n  (lex | parse)\ncatch\n  .\n')
  assert.equal(
    fmt('try\n  if .a then .b\n  else .c\n  end'),
    'try\n  if .a then .b\n  else .c\n  end\n'
  )
  // try 的 body 缩进锚到 try 关键字列（管道行内 'try' 在第 4 列）
  assert.equal(fmt('| try\n    _e(.)'), '| try\n    _e(.)\n')
})

test('as binding pattern on its own line', () => {
  // 源码在 as 之后换行：绑定模式另起一行，比操作数表达式的起始列深
  // 一层（'| $query' 的操作数从第 2 列起）
  assert.equal(fmt('| $query as\n    { term: 1 }'), '| $query as\n    {term: 1}\n')
  // 操作数是调用表达式时锚到函数名列（'map' 从第 2 列起）
  assert.equal(fmt('| map(.x) as\n    { a }'), '| map(.x) as\n    {a}\n')
  // 同行不换行；对象键的 try/as 不受影响
  assert.equal(fmt('.x as $v | $v'), '.x as $v | $v\n')
  assert.equal(fmt('{try: 1, as: 2}'), '{try: 1, as: 2}\n')
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
  // 注释迫使展开；开括号后接了内容 → 悬挂式，保留源码换行
  assert.equal(fmt('{a: 1, # first\nb: 2}'), '{ a: 1, # first\n  b: 2 }\n')
})

test('keyword-named object keys do not trigger clause logic', () => {
  // 形如子句/def 关键字的对象键必须保持单行，且不得开关 if/try
  // 上下文、不得被当作定义
  assert.equal(
    fmt('{if: 1, then: 2, else: 3, end: 4, catch: 5, try: 6, def: 7}'),
    '{if: 1, then: 2, else: 3, end: 4, catch: 5, try: 6, def: 7}\n'
  )
  // 对象键不得捕获或弹掉真实 if 的子句缩进
  const src = 'if .a\nthen {if: 1, end: 2}\nelse .b\nend'
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

test('single-line object literals do not pad inside braces', () => {
  // 各种括号一致：单行组内侧不补（悬挂式展开组才补，见下面的用例）
  assert.equal(fmt('{a: 1}'), '{a: 1}\n')
  assert.equal(fmt('{  a: 1  }'), '{a: 1}\n') // 不能多
  assert.equal(fmt('{a:1}'), '{a: 1}\n') // 冒号后空格仍在
  // 嵌套大括号同样不补
  assert.equal(fmt('{a: {b: 1}}'), '{a: {b: 1}}\n')
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

test('keyword field names after a dot keep source adjacency', () => {
  // '.catch' 是字段访问（等价 '.["catch"]'），'. catch' 是身份后跟关键
  // 字（语法错误）；反方向同样危险：'else . end' 收紧成 '.end' 会变成
  // 字段访问。点号与关键字之间的间距只能按源码邻接保留，不可归一化
  assert.equal(fmt('.catch = $c'), '.catch = $c\n')
  assert.equal(
    fmt('if $end_ then .end = $end_ else . end'),
    'if $end_ then .end = $end_ else . end\n'
  )
  assert.equal(fmt('{a: $if_.then, b: $if_.else}'), '{a: $if_.then, b: $if_.else}\n')
  assert.equal(fmt('$q.term.reduce as $r'), '$q.term.reduce as $r\n')
  // 源码有空格的保持空格（身份 + 子句关键字）
  assert.equal(fmt('if .a then .b else . end'), 'if .a then .b else . end\n')
  assert.equal(fmt('if . then 1 else 2 end'), 'if . then 1 else 2 end\n')
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
  // 开括号落在 '| …' 续行（缩进 1）上的组，内容比该行再深一层，
  // 闭括号回到该行的层级。map( 后接了内容 → 悬挂式，内侧补空格。
  assert.equal(fmt('.a\n| map({\n  b: 1\n})'), '.a\n  | map( {\n    b: 1\n  } )\n')
  assert.equal(fmt('.a\n| {\n  b: 1\n}'), '.a\n  | {\n    b: 1\n  }\n')
})

test('leading separators align with the opening bracket', () => {
  // 悬挂组里源码在 ','/';' 之前换行：分隔符提到行首，与开括号同列
  assert.equal(fmt('{ a: 1\n, b: 2\n}'), '{ a: 1\n, b: 2\n}\n')
  assert.equal(fmt('[ 1\n, 2\n]'), '[ 1\n, 2\n]\n')
  assert.equal(
    fmt('reduce .[] as $x ( 0\n; . + $x\n)'),
    'reduce .[] as $x ( 0\n                 ; . + $x\n                 )\n'
  )
  // 开括号在行中间（前导运算符之后）：前导分隔符与闭括号对齐到开括号列
  assert.equal(
    fmt('p\n+ { "ENV": $env # comment\n  , "ARGS": $opts\n  }'),
    'p\n+ { "ENV": $env # comment\n  , "ARGS": $opts\n  }\n'
  )
  // 开括号行上的行尾注释不参与宽度测量，不把组挤成分隔式
  assert.equal(fmt('[ # note\n  1\n, 2\n]'), '[ # note\n  1\n, 2\n]\n')
  // 无前导分隔符的悬挂组：闭括号对齐到开括号列；调用式开括号
  //（'x('，与前一个 token 粘连）例外，回到开括号所在行的行首
  assert.equal(fmt('x( "aaa"\n+ "bbb"\n)'), 'x( "aaa"\n+ "bbb"\n)\n')
  assert.equal(fmt('[ .\n  , { a: 1\n    , b: 2\n    }\n  ]'), '[ .\n, { a: 1\n  , b: 2\n  }\n]\n')
})

test('object values break after the colon where the source does', () => {
  // 对象键的冒号之后源码换行：值另起一行。冒号之下开启一个层级：
  // 值比键表达式的起始列深一层 —— 键前有 '{ ' 或 ', ' 前缀（开括号/
  // 分隔符中置）时，按组内容层算会让值与键同列
  assert.equal(fmt('{ key:\n  value\n}'), '{ key:\n    value\n}\n')
  assert.equal(fmt('[ { a:\n    1\n}\n]'), '[ { a:\n      1\n  }\n]\n')
  // 冒号后源码未换行：值留在本行
  assert.equal(fmt('{ a: 1,\n  b: 2\n}'), '{ a: 1,\n  b: 2\n}\n')
  // 切片冒号不受影响
  assert.equal(fmt('.[2:5]'), '.[2:5]\n')
})

test('elements that break internally stay on the separator line', () => {
  // 前导分隔符后的元素内部会断行（键后换行、嵌套展开组）时，
  // 不在分隔符后强行另起一行，避免分隔符孤零零留在行尾
  assert.equal(
    fmt('{ a: 1\n, key:\n    ( if x then y\n       else z\n       end\n     )\n}'),
    '{ a: 1\n, key:\n    ( if x then y\n      else z\n      end\n    )\n}\n'
  )
})

test('then stays on the elif line when the source breaks after it', () => {
  // 子句关键字后（跳过注释）源码换行：then 留在本行，不因分支内容
  // 平铺超宽而被挤到单独一行
  const src = 'if .a then "aaa"\nelif .b then\n# note\n( "bbb"\n+ "ccc"\n)\nelse .\nend'
  assert.equal(
    fmt(src),
    'if .a then "aaa"\nelif .b then\n  # note\n  ( "bbb"\n  + "ccc"\n  )\nelse .\nend\n'
  )
  // 源码在 then 之后换行：分支内容另起一行，比子句关键字深一层，
  // 分支内的注释对齐到分支内容
  assert.equal(
    fmt('if .a then\n  # note\n  .b\nelse\n  .c\nend'),
    'if .a then\n  # note\n  .b\nelse\n  .c\nend\n'
  )
  // then 之后源码未换行：内容留在本行
  assert.equal(fmt('if .a then .b\nelse .c\nend'), 'if .a then .b\nelse .c\nend\n')
})

test('source break after a reduce as-pattern is preserved', () => {
  // reduce/foreach 分组的 '(' 之前源码换行：原样保留，缩进比 as 行
  // 深一层（jqjq 语料 41 行的形态）
  assert.equal(
    fmt('reduce ($paths | unique | reverse)[] as $p\n  (.; _delpath($p));'),
    'reduce ($paths | unique | reverse)[] as $p\n  (.; _delpath($p));\n'
  )
  // 析构模式同样适用
  assert.equal(
    fmt('foreach .[] as [$k, $v]\n  (0; . + [$k]; .)'),
    'foreach .[] as [$k, $v]\n  (0; . + [$k]; .)\n'
  )
  // 源码未换行：不主动断行，单行保持
  assert.equal(
    fmt('reduce ($paths | unique | reverse)[] as $p (.; _delpath($p));'),
    'reduce ($paths | unique | reverse)[] as $p (.; _delpath($p));\n'
  )
})

test('single-key object with an internally breaking value stays hanging', () => {
  // 首个断点落在嵌套组内部的单键对象：悬挂式判定按首个实际断点量
  // 开括号行宽度，而不是整组平铺 —— 否则键会被挤到单独一行
  //（jqjq 语料 629 行的形态）
  const src = [
    '[ .',
    '  , { term:',
    '      { type: "TermTypeReduce"',
    '      , reduce:',
    '          { term: $term.term',
    '          , pattern: $pattern',
    '          }',
    '      }',
    '    }',
    '  ]'
  ].join('\n')
  const expected =
    [
      '[ .',
      ', { term:',
      '      { type: "TermTypeReduce"',
      '      , reduce:',
      '          { term: $term.term',
      '          , pattern: $pattern',
      '          }',
      '      }',
      '  }',
      ']'
    ].join('\n') + '\n'
  assert.equal(fmt(src), expected)
  assert.equal(fmt(expected), expected)
})

test('trailing-style binop and pipe breaks are preserved', () => {
  // 运算符留在行尾的折行（尾随风格）与行首风格同样尊重源码：
  // 双目运算符之后的操作数与本行同层，管道之后深一层；if 条件里的
  // 折行改锚条件层（if 关键字列 +1 层，见下方专项测试）
  assert.equal(
    fmt('if $op | . == "=" or\n  . == "|=" or\n  . == "+=" then 1 else 2 end'),
    'if $op | . == "=" or\n  . == "|=" or\n  . == "+=" then 1 else 2 end\n'
  )
  assert.equal(fmt('.a //\n  .b'), '.a //\n.b\n')
  assert.equal(fmt('.a |\n  b'), '.a |\n  b\n')
  // 行首风格（运算符提到下一行行首）在 if 条件里同样锚条件层
  assert.equal(
    fmt('if $op | . == "="\n  or . == "|="\n  or . == "+=" then 1 else 2 end'),
    'if $op | . == "="\n  or . == "|="\n  or . == "+=" then 1 else 2 end\n'
  )
  // 源码未换行：不主动断行
  assert.equal(fmt('.a // .b'), '.a // .b\n')
  assert.equal(fmt('true and false or null'), 'true and false or null\n')
})

test('trailing break suppresses the leading overflow break at the same operator', () => {
  // 尾随风格已折行的运算符不抢断：不把折行挪到运算符之前；源码
  // 未折行且超宽的运算符仍做行首补断
  const src =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa or\n  bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb or c'
  const once = fmt(src, 60)
  assert.equal(
    once,
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa or\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nor c\n'
  )
  assert.equal(fmt(once, 60), once)
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
    '[1,\n  2\n]',
    '[.x as $v |\ndef f: .a; f]'
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
