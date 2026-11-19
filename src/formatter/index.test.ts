/**
 * 格式化器行为测试 —— 断言以 STYLE.md 为规范基准。
 * 解析器的文法覆盖见 parser/parse.test.ts；语料回归见 corpus.test.ts。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatJq, FormatError } from './index'

const fmt = (src: string, printWidth = 100) => formatJq(src, { printWidth })

// ---- 横向间距（保留行为） -----------------------------------------------

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

test('leading-dot number literals', () => {
  assert.equal(fmt('.5+.5e2'), '.5 + .5e2\n')
  assert.equal(fmt('[.5, .25]'), '[.5, .25]\n')
  assert.equal(fmt('{a: .5}'), '{a: .5}\n')
  assert.equal(fmt('-.5'), '-.5\n')
  assert.equal(fmt('.a[0] | .[]'), '.a[0] | .[]\n')
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

// ---- 语义守护（保留行为） -----------------------------------------------

test('keyword field names after a dot keep source adjacency', () => {
  // '.catch' 是字段访问（等价 '.["catch"]'），'. catch' 是身份后跟关键
  // 字（语法错误）；反方向同样危险：'else . end' 收紧成 '.end' 会变成
  // 字段访问。点号与关键字之间的间距只能按源码邻接保留，不可归一化
  assert.equal(fmt('.catch = $c'), '.catch = $c\n')
  assert.equal(fmt('.true|.false.null'), '.true | .false.null\n')
  assert.equal(
    fmt('if $end_ then .end = $end_ else . end'),
    'if $end_ then .end = $end_ else . end\n'
  )
  assert.equal(fmt('{a: $if_.then, b: $if_.else}'), '{a: $if_.then, b: $if_.else}\n')
  assert.equal(fmt('$q.term.reduce as $r | $r'), '$q.term.reduce as $r | $r\n')
  assert.equal(fmt('if .a then .b else . end'), 'if .a then .b else . end\n')
  assert.equal(fmt('if . then 1 else 2 end'), 'if . then 1 else 2 end\n')
})

test('keyword-named object keys do not trigger clause logic', () => {
  assert.equal(
    fmt('{if: 1, then: 2, else: 3, end: 4, catch: 5, try: 6, def: 7}'),
    '{if: 1, then: 2, else: 3, end: 4, catch: 5, try: 6, def: 7}\n'
  )
  // 对象键不得捕获或弹掉真实 if 的子句缩进
  const src = 'if .a\nthen {if: 1, end: 2}\nelse .b\nend'
  assert.equal(fmt(src), src + '\n')
})

// ---- R1 链：行首运算符 ---------------------------------------------------

test('pipeline breaks with leading pipe at the same indent', () => {
  // 超宽：行首管道，与链起始行同层（不加缩进）
  assert.equal(
    fmt('.aaaaaaaaaaaa | .bbbbbbbbbbbb | .cccccccccccc', 20),
    '.aaaaaaaaaaaa\n| .bbbbbbbbbbbb\n| .cccccccccccc\n'
  )
  // 作者断行：保留（尾随风格归一化为行首风格）
  assert.equal(fmt('.a\n| .b'), '.a\n| .b\n')
  assert.equal(fmt('.a |\n  b'), '.a\n| b\n')
  // 同层不加缩进也适用于空行之后
  assert.equal(fmt('.a\n\n| .b'), '.a\n\n| .b\n')
})

test('binary operators break with leading operator', () => {
  const wide = '"aaaaaaaaaaaaaaaaaaaaaaaaaa" + "bbbbbbbbbbbbbbbbbbbbbbbbbb" + "ccccccccccccccccccc"'
  assert.equal(
    fmt(wide, 40),
    '"aaaaaaaaaaaaaaaaaaaaaaaaaa"\n+ "bbbbbbbbbbbbbbbbbbbbbbbbbb"\n+ "ccccccccccccccccccc"\n'
  )
  // 源码尾随风格归一化为行首风格
  assert.equal(fmt('.a //\n  .b'), '.a\n// .b\n')
  // 运算符前后都断行：运算符独占一行，操作数另起一行（cont +1 层）
  //（jqjq 语料 _func_defs 的形态）
  assert.equal(
    fmt('( _consume(.ident)\n)\n//\n  ( _consume(.binding)\n  )'),
    '( _consume(.ident)\n)\n//\n  ( _consume(.binding)\n  )\n'
  )
  // 行内放得下：不断行
  assert.equal(fmt('.a + .b | .c'), '.a + .b | .c\n')
  assert.equal(fmt('.a // .b'), '.a // .b\n')
  // 一元负号不是断点
  assert.equal(fmt('[-1, -2]'), '[-1, -2]\n')
})

test('operator chains in nested contexts indent one level deeper', () => {
  // 链以子句/键前缀开始时，续行取该行缩进 +1 层；子句关键字不因续行
  // 或分支内容而被强制换行，留在原地
  assert.equal(
    fmt('if $op | . == "=" or . == "|=" or\n  . == "+=" then 1 else 2 end'),
    'if $op | . == "=" or . == "|="\n  or . == "+=" then 1 else 2 end\n'
  )
  assert.equal(
    fmt('{key: .aaaaaaaaaaaaaaaa +\n  .bbbbbbbbbbbbbbbbbbbb}'),
    '{ key: .aaaaaaaaaaaaaaaa\n  + .bbbbbbbbbbbbbbbbbbbb }\n'
  )
})

// ---- R2 组：展开或单行 ---------------------------------------------------

test('single-line groups stay single-line without inner padding', () => {
  assert.equal(fmt('{a: 1}'), '{a: 1}\n')
  assert.equal(fmt('{  a: 1  }'), '{a: 1}\n')
  assert.equal(fmt('{a:1}'), '{a: 1}\n')
  assert.equal(fmt('{a: {b: 1}}'), '{a: {b: 1}}\n')
  assert.equal(fmt('[1, 2, 3]'), '[1, 2, 3]\n')
  assert.equal(fmt('map( .a )'), 'map(.a)\n')
  assert.equal(fmt('f(  1  )'), 'f(1)\n')
  assert.equal(fmt('{}'), '{}\n')
  assert.equal(fmt('map([])'), 'map([])\n')
})

test('groups expand when they do not fit', () => {
  const src = '{"aaaaaaaaaa": 1, "bbbbbbbbbb": 2, "cccccccccc": 3}'
  assert.equal(fmt(src, 40), '{\n  "aaaaaaaaaa": 1,\n  "bbbbbbbbbb": 2,\n  "cccccccccc": 3\n}\n')
})

test('groups: single line, hanging, or fully expanded per author intent', () => {
  // 单行：无作者断行/注释、放得下
  assert.equal(fmt('[1, 2, 3]'), '[1, 2, 3]\n')
  // 分隔展开：作者在开括号之后断行 —— 每元素一行
  const src = '{\n  "a": 1,\n  "b": 2\n}'
  assert.equal(fmt(src), src + '\n')
  assert.equal(fmt('[\n# note\n1]'), '[\n  # note\n  1\n]\n')
  // 悬挂：首元素写在开括号行上、组内另有断行 —— 保留作者形态
  assert.equal(fmt('[1, 2,\n  3]'), '[ 1, 2,\n  3 ]\n')
  assert.equal(fmt('[1,\n  2\n]'), '[ 1,\n  2\n]\n')
  // 前导分隔符风格归一化为尾随分隔符（悬挂形态不变）
  assert.equal(fmt('[ .\n, 2\n]'), '[ .,\n  2\n]\n')
  assert.equal(fmt('{ a: 1\n, b: 2\n}'), '{ a: 1,\n  b: 2\n}\n')
  // 悬挂的括号链：链对齐开括号列、闭括号回开括号列，内侧补位；行中
  // 开括号（'gsub( ('）时链锚开括号列而非行首（jqjq 语料 gsub 的形态）
  assert.equal(
    fmt('gsub(( "aaa"\n+ "bbb"\n+ "ccc"\n); .)'),
    'gsub( ( "aaa"\n      + "bbb"\n      + "ccc"\n      ); . )\n'
  )
  // 开括号行上的行尾注释：留在开括号行（其后强制断行）
  assert.equal(fmt('[# note\n1]'), '[ # note\n  1\n]\n')
})

test('comments at the group level keep the author form', () => {
  // 首元素在开括号行上：悬挂，注释与后续元素对齐到元素层
  assert.equal(fmt('{a: 1, # first\nb: 2}'), '{ a: 1, # first\n  b: 2 }\n')
  assert.equal(fmt('[1,\n# note\n2]'), '[ 1,\n  # note\n  2 ]\n')
})

test('reduce / foreach groups follow the generic group rules', () => {
  assert.equal(fmt('reduce .[] as $x (0; . + $x)'), 'reduce .[] as $x (0; . + $x)\n')
  const src = 'reduce .[] as $x (\n  0;\n  . + $x\n)'
  assert.equal(fmt(src), src + '\n')
  // 作者在 as 绑定模式之后断行：组另起一行，比 reduce 行深一层
  assert.equal(
    fmt('reduce ($paths | unique | reverse)[] as $p\n  (.; _delpath($p))'),
    'reduce ($paths | unique | reverse)[] as $p\n  (.; _delpath($p))\n'
  )
  assert.equal(
    fmt('foreach .[] as [$k, $v]\n  (0; . + [$k]; .)'),
    'foreach .[] as [$k, $v]\n  (0; . + [$k]; .)\n'
  )
})

test('groups on a pipe-continuation line indent from that line', () => {
  // 唯一对象实参拥抱：实参组不展开，对象自身展开、闭括号贴尾
  assert.equal(fmt('.a\n| map({\n  b: 1\n})'), '.a\n| map({\n  b: 1\n})\n')
})

test('sole object/array argument is hugged', () => {
  assert.equal(fmt('map({\n  b: 1\n})'), 'map({\n  b: 1\n})\n')
  assert.equal(fmt('map([\n  1,\n  2\n])'), 'map([\n  1,\n  2\n])\n')
  // 两个实参不拥抱：悬挂的实参组按作者形态保留（`; [` 不断行）。
  // 实参组的基础缩进＝实参的 home（悬挂首元素＝元素列 3）：元素在
  // 3＋1 层，闭括号回 3（与 `( eval_ast(` 的作者锚定同形）
  assert.equal(fmt('f([\n  1\n]; [\n  2\n])'), 'f( [\n     1\n   ]; [\n     2\n   ] )\n')
})

// ---- R3 对象条目 ---------------------------------------------------------

test('object construction', () => {
  assert.equal(fmt('{a: 1, "b": 2, $c}'), '{a: 1, "b": 2, $c}\n')
  assert.equal(fmt('{if: 1, end: 2}'), '{if: 1, end: 2}\n')
  // 尾逗号默认去掉（trailingComma 选项，见下方专项测试）
  assert.equal(fmt('{a: 1,}'), '{a: 1}\n')
})

test('object values stay on the key line; continuation indents one level', () => {
  // 冒号后源码未换行：值留在键行
  assert.equal(fmt('{a: 1, b: 2}'), '{a: 1, b: 2}\n')
  // 冒号后的源码换行：保留，值另起一行（条目 home＋1 层 —— 悬挂条目
  // 的 home 是元素列 2，故值在 4；jqjq 语料 39 处冒号断行全部如此）；
  // 对象保持作者的悬挂形态，闭括号按作者贴行
  assert.equal(fmt('{ key:\n  value\n}'), '{ key:\n    value\n}\n')
  // 值内部断行：续行取条目缩进 +1 层
  assert.equal(
    fmt('{ key: .aaaaaaaaaaaaaaaa +\n  .bbbbbbbbbbbbbbbbbbbb }'),
    '{ key: .aaaaaaaaaaaaaaaa\n  + .bbbbbbbbbbbbbbbbbbbb }\n'
  )
  // 切片冒号不受影响
  assert.equal(fmt('.[2:5]'), '.[2:5]\n')
})

// ---- R4/R5 子句 ----------------------------------------------------------

test('if/elif/else/end clauses', () => {
  assert.equal(fmt('if .a then .b else .c end'), 'if .a then .b else .c end\n')
  const src = ['if .a', 'then .b', 'elif .c', 'then .d', 'else .e', 'end'].join('\n')
  assert.equal(fmt(src), src + '\n')
  // 子句关键字后源码换行：体另起一行 +1 层
  assert.equal(
    fmt('if .a then\n  # note\n  .b\nelse\n  .c\nend'),
    'if .a then\n  # note\n  .b\nelse\n  .c\nend\n'
  )
  // 子句关键字后未换行且放得下：体留在关键字行
  assert.equal(fmt('if .a then .b\nelse .c\nend'), 'if .a then .b\nelse .c\nend\n')
  // 关键字不因分支内容多行/超宽被挤下：then 留在 if 行，体保持作者
  // 的悬挂形态（jqjq 语料 _unescape 的形态）
  assert.equal(
    fmt('if .surrogate then\n  ( .surrogate\n  | implode\n  )\nend'),
    'if .surrogate then\n  ( .surrogate\n  | implode\n  )\nend\n'
  )
  // 关键字自身放不下：换行回 if 缩进
  assert.equal(
    fmt('if .aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa then .b end', 40),
    'if .aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nthen .b end\n'
  )
})

test('try/catch', () => {
  assert.equal(fmt('try .a catch .b'), 'try .a catch .b\n')
  const src = 'try .a\ncatch .b'
  assert.equal(fmt(src), 'try .a\ncatch .b\n')
  // 源码在 try 之后换行：body 另起一行，比 try 所在层深一层
  assert.equal(fmt('try\n  (lex | parse)'), 'try\n  (lex | parse)\n')
  assert.equal(fmt('try\n  (lex | parse)\ncatch\n  .'), 'try\n  (lex | parse)\ncatch\n  .\n')
})

// ---- R6/R7/R8 ------------------------------------------------------------

test('author breaks are preserved at every breakable boundary (as family)', () => {
  assert.equal(fmt('.x as $v | $v'), '.x as $v | $v\n')
  assert.equal(fmt('. as [$a] ?// {$b} | $a'), '. as [$a] ?// {$b} | $a\n')
  // head 与 'as' 之间断行：'as' 行首风格归一化到 cont
  assert.equal(fmt('.a + .b\nas $x | $x'), '.a + .b\nas $x | $x\n')
  // 'as' 之后断行：绑定模式另起一行，比 as 行深一层
  assert.equal(fmt('.x as\n  { term: $t } | .y'), '.x as\n  {term: $t} | .y\n')
  // '?//' 备选之间断行：分隔符尾随，备选另起一行
  assert.equal(fmt('. as [$a, $b] ?//\n  {$c} | .'), '. as [$a, $b] ?//\n  {$c} | .\n')
  assert.equal(fmt('. as [$a, $b]\n?// {$c} | .'), '. as [$a, $b] ?//\n  {$c} | .\n')
  // 模式之后断行：'|' 行首风格归一化到 cont（尾随风格同样归一化）
  assert.equal(fmt('.x as $v\n| $v'), '.x as $v\n| $v\n')
  assert.equal(fmt('.x as $v |\n  $v'), '.x as $v\n| $v\n')
  // label 的 '$out |' 同形处理
  assert.equal(fmt('label $out\n| .[] | .'), 'label $out\n| .[] | .\n')
  assert.equal(fmt('label $out |\n  .[] | .'), 'label $out\n| .[] | .\n')
  assert.equal(fmt('label $out | .[]'), 'label $out | .[]\n')
})

test('author breaks are preserved at every breakable boundary (reduce family)', () => {
  assert.equal(fmt('reduce .[] as $x (0; . + $x)'), 'reduce .[] as $x (0; . + $x)\n')
  // 关键字之后断行：源表达式另起一行，比关键字行深一层
  assert.equal(fmt('reduce\n  .[] as $x (0; . + $x)'), 'reduce\n  .[] as $x (0; . + $x)\n')
  // 'as' 之后断行：模式另起一行
  assert.equal(fmt('reduce .[] as\n  $x (0; . + $x)'), 'reduce .[] as\n  $x (0; . + $x)\n')
  // 模式之后断行：分组另起一行
  assert.equal(
    fmt('reduce ($paths | unique | reverse)[] as $p\n  (.; _delpath($p))'),
    'reduce ($paths | unique | reverse)[] as $p\n  (.; _delpath($p))\n'
  )
  assert.equal(
    fmt('foreach .[] as [$k, $v]\n  (0; . + [$k]; .)'),
    'foreach .[] as [$k, $v]\n  (0; . + [$k]; .)\n'
  )
})

test('author breaks are preserved at every breakable boundary (def params)', () => {
  assert.equal(fmt('def f(a; b): .a;'), 'def f(a; b): .a;\n')
  // 参数边界断行：首参在开括号行上 → 悬挂形态，后续参数对齐首参列；
  // 体随 ':' 留在闭括号行
  assert.equal(fmt('def f(a;\n  b): .a;'), 'def f( a;\n       b ): .a;\n')
})

test('hug does not apply when the author breaks inside the argument group', () => {
  // 实参组自身层级的断行：按展开处理，不拥抱
  assert.equal(fmt('map(\n  {a: 1}\n)'), 'map(\n  {a: 1}\n)\n')
  // 断行在实参内部（对象自身边界）：仍然拥抱
  assert.equal(fmt('map({\n  a: 1\n})'), 'map({\n  a: 1\n})\n')
})

test('def formatting', () => {
  assert.equal(fmt('def f(a;b):.a|f;'), 'def f(a; b): .a | f;\n')
  assert.equal(fmt('def f: .a | .b; .f'), 'def f: .a | .b; .f\n')
  // def 之间的空行原样保留（最多两个）
  assert.equal(fmt('def f: .a;\n\ndef g: .b;\n.f'), 'def f: .a;\n\ndef g: .b;\n.f\n')
  assert.equal(fmt('def f: .a;\n\n\ndef g: .b;\n.f'), 'def f: .a;\n\n\ndef g: .b;\n.f\n')
  assert.equal(
    fmt('# shebang block\n# notes\n\ndef f: .a;\n.f'),
    '# shebang block\n# notes\n\ndef f: .a;\n.f\n'
  )
  assert.equal(fmt('# c\ndef f: .a;\n.f'), '# c\ndef f: .a;\n.f\n')
  assert.equal(fmt('def f: .a;\n# c\ndef g: .b;'), 'def f: .a;\n# c\ndef g: .b;\n')
  // def 体超宽：另起一行 +1 层
  assert.equal(
    fmt('def f: .aaaaaaaaaaaa | .bbbbbbbbbbbb | .cccccccccccc;', 30),
    'def f:\n  .aaaaaaaaaaaa\n  | .bbbbbbbbbbbb\n  | .cccccccccccc;\n'
  )
})

test('def inside a group or pipe segment', () => {
  // 管道段带前导 def：放得下时 def 留在 '|' 行，其后的查询另起一行
  assert.equal(fmt('a | def f: 1; b'), 'a | def f: 1; b\n')
  // 放不下时 def 段以行首 '|' 起新行
  assert.equal(
    fmt('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | def f: 1; b', 30),
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n| def f: 1; b\n'
  )
  // 组内 def：数组保持作者的悬挂形态（首元素在开括号行上），as 模式
  // 后的断行保留（'|' 行首风格），def 之后的查询再起一行，闭括号按
  // 作者贴行
  assert.equal(fmt('[.x as $v |\ndef f: .a; f]'), '[ .x as $v\n| def f: .a; f ]\n')
})

test('siblings after a def anchor to the item indent, not the last body line', () => {
  // 回归：内层 def 的体结束在深一层的行上（end; 在 +2 层），其后同一
  // 条目的 head 与后续顶层 def 不得被带偏到那一层 —— 条目基准缩进
  // 在入口捕获（jqjq 语料 _delpaths 的形态）
  const src = [
    'def outer($paths):',
    '  def inner($p):',
    '    if $p == [] then empty',
    '    else .',
    '    end;',
    '  reduce ($paths | unique)[] as $p (.; inner($p));',
    '',
    'def next: .a;',
    '.'
  ].join('\n')
  assert.equal(
    fmt(src),
    [
      'def outer($paths):',
      '  def inner($p):',
      '    if $p == [] then empty',
      '    else .',
      '    end;',
      '  reduce ($paths | unique)[] as $p (.; inner($p));',
      '',
      'def next: .a;',
      '.',
      ''
    ].join('\n')
  )
})

test('reduce / foreach / label / break', () => {
  assert.equal(
    fmt('foreach .[] as $x (0; . + $x; . * 2)'),
    'foreach .[] as $x (0; . + $x; . * 2)\n'
  )
  assert.equal(
    fmt('label $out | .[] | if . then . else break $out end'),
    'label $out | .[] | if . then . else break $out end\n'
  )
})

test('import / include / module', () => {
  assert.equal(
    fmt('module {name: "x"}; import "a" as b; include "c"; .'),
    'module {name: "x"};\nimport "a" as b;\ninclude "c";\n.\n'
  )
})

// ---- R10/R11 注释与空行 --------------------------------------------------

test('comments', () => {
  assert.equal(fmt('# header\n.a # trailing\n'), '# header\n.a # trailing\n')
  // 管道与注释：注释归属行首管道所在的续行
  assert.equal(fmt('.a | # note\n.b'), '.a\n| # note\n.b\n')
  // 行尾注释间距：不足一个空格补一个，其余按源码原样保留
  assert.equal(fmt('.a# tight'), '.a # tight\n')
  assert.equal(fmt('.a    # wide'), '.a    # wide\n')
  // 代码被重新排版后，注释间距仍以源码为准
  assert.equal(fmt('1  +  2   # c'), '1 + 2   # c\n')
})

test('comment backslash continuation (jq 1.8 spec)', () => {
  // 行尾是奇数个反斜杠：下一行属于注释，原样保留、绝不重排缩进
  assert.equal(fmt('[.[]] # c \\\n, 99 is comment'), '[.[]] # c \\\n, 99 is comment\n')
  // 偶数个：下一行是代码，正常格式化（断行的逗号条目深一层）
  assert.equal(fmt('1, # even \\\\\n2'), '1, # even \\\\\n  2\n')
  // 独立的续行注释
  assert.equal(fmt('# a \\\ncont line\n. as $x | $x'), '# a \\\ncont line\n. as $x | $x\n')
  // jq 里反斜杠后跟空格不算续行；这个空格必须在格式化后保留
  assert.equal(fmt('2 # c \\ \n+ 3'), '2 # c \\ \n+ 3\n')
})

test('blank lines: preserved verbatim, never added, capped at two', () => {
  assert.equal(fmt('.a\n\n| .b'), '.a\n\n| .b\n')
  assert.equal(fmt('.a\n\n\n\n| .b'), '.a\n\n\n| .b\n')
  assert.equal(fmt('if .a\n\nthen .b else .c end'), 'if .a\n\nthen .b else .c end\n')
  const arr = '[\n  1,\n\n  2\n]'
  assert.equal(fmt(arr), arr + '\n')
  const commented = '.a\n\n# note\n\n.b | .c'
  assert.equal(fmt(commented), commented + '\n')
  assert.equal(fmt('# a\n\n# b\n.c'), '# a\n\n# b\n.c\n')
  assert.equal(fmt('.a # c\n\n| .b'), '.a # c\n\n| .b\n')
  // 源码没有空行：行宽断行也不凭空增加
  assert.equal(fmt('.aaaaaaaa | .bbbbbbbb', 10), '.aaaaaaaa\n| .bbbbbbbb\n')
})

// ---- 尾随逗号（trailingComma 选项，仅对象构造）---------------------------

test('trailing comma never (default): stripped in single-line and expanded forms', () => {
  assert.equal(fmt('{a: 1,}'), '{a: 1}\n')
  assert.equal(fmt('[{a: 1,}]'), '[{a: 1}]\n')
  assert.equal(fmt('f({a: {b: 1,},})'), 'f({a: {b: 1}})\n')
  // 被移除的内层逗号也不参与外层组的行宽判定
  assert.equal(fmt('[{a: 1,}]', 8), '[{a: 1}]\n')
  assert.equal(fmt('{\n  a: 1,\n  b: 2,\n}'), '{\n  a: 1,\n  b: 2\n}\n')
  // 末条目与闭括号之间的注释原位保留
  assert.equal(fmt('{a: 1, # note\n}'), '{ a: 1 # note\n}\n')
  // 独占一行的尾随逗号被去掉后不得凭空新增空行（其源码行仍计入保持）
  assert.equal(fmt('{\n  a: 1\n,\n}'), '{\n  a: 1\n}\n')
  assert.equal(fmt('{\n  a: 1\n,\n\n}'), '{\n  a: 1\n\n}\n')
})

test('trailing comma multiline: added in expanded objects, removed in single-line ones', () => {
  const m = (src: string, printWidth = 100) =>
    formatJq(src, { printWidth, trailingComma: 'multiline' })
  assert.equal(m('{a: 1,}'), '{a: 1}\n') // 单行去掉
  assert.equal(m('[{a: 1,}]', 8), '[{a: 1}]\n')
  assert.equal(m('{a: 1,}\n', 6), '{a: 1}\n')
  assert.equal(m('{a: 1, b: 2}'), '{a: 1, b: 2}\n') // 单行不补
  assert.equal(m('{\n  a: 1,\n  b: 2\n}'), '{\n  a: 1,\n  b: 2,\n}\n') // 展开补齐
  assert.equal(m('{aaa: 1, bbb: 2}', 10), '{\n  aaa: 1,\n  bbb: 2,\n}\n') // 超宽被迫展开
  assert.equal(m('map({\n  a: 1\n})'), 'map({\n  a: 1,\n})\n') // 拥抱实参内的对象
  assert.equal(m('{ a: 1,\n  b: 2 }'), '{ a: 1,\n  b: 2, }\n') // 悬挂形态
  assert.equal(m('{ x: {\n  a: 1\n}}'), '{ x: {\n    a: 1,\n  }, }\n') // 嵌套各自独立
  // 补齐的逗号紧贴末条目、位于闭括号前注释之前
  assert.equal(m('{\n  a: 1 # note\n}'), '{\n  a: 1, # note\n}\n')
})

test('trailing comma preserve: source kept verbatim in both forms', () => {
  const p = (src: string) => formatJq(src, { trailingComma: 'preserve' })
  assert.equal(p('{a: 1,}'), '{a: 1,}\n')
  assert.equal(p('[{a: 1,}]'), '[{a: 1,}]\n')
  assert.equal(p('{a: 1}'), '{a: 1}\n')
  assert.equal(p('{\n  a: 1,\n  b: 2,\n}'), '{\n  a: 1,\n  b: 2,\n}\n')
  assert.equal(p('{\n  a: 1,\n  b: 2\n}'), '{\n  a: 1,\n  b: 2\n}\n')
})

test('trailing comma modes are idempotent', () => {
  for (const mode of ['never', 'multiline', 'preserve'] as const) {
    for (const src of [
      '{a: 1,}',
      '{\n  a: 1,\n  b: 2,\n}',
      '{\n  a: 1,\n  b: 2\n}',
      'map({\n  a: 1\n})',
      '{a: 1 # c\n}',
      '{a: 1,  # c\n}',
      '{a: 1 # c\n,}',
      '{a: 1\n# before comma\n,\n# after comma\n}',
      '{\n  a: 1\n# before comma\n, # after comma\n}',
      '{a: (\n .\n)}',
      '{a: (\n .\n), }',
      '[{a: 1,}, {b: (\n .)}]'
    ]) {
      const once = formatJq(src, { trailingComma: mode })
      assert.equal(
        formatJq(once, { trailingComma: mode }),
        once,
        `not idempotent (${mode}): ${src}`
      )
    }
  }
})

test('trailing commas stay illegal outside object constructors', () => {
  // 数组 / 函数实参 / 解构模式中的尾随逗号是 jq 语法错误，与选项无关
  assert.throws(() => fmt('[1, 2,]'), FormatError)
  assert.throws(() => fmt('f(1; 2;)'), FormatError)
  assert.throws(() => fmt('. as {$a,} | .'), FormatError)
})

// ---- R13 封套与错误 ------------------------------------------------------

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
    '[.x as $v |\ndef f: .a; f]',
    'module {name: "x"};\nimport "a" as b;\ninclude "c";\n.',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa or\n  bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb or c'
  ]
  for (const s of samples) {
    const once = fmt(s)
    assert.equal(fmt(once), once, `not idempotent for: ${JSON.stringify(s)}`)
  }
})

test('token sequence is preserved (whitespace-only guarantee)', () => {
  // 重新词法化输出：非注释 token 文本序列与输入完全一致
  const { tokenize } = require('../tokenizer')
  const samples = [
    'def f(a;b):.a|f;\n.x as $v|$v|f(1;2)',
    '{a:1,b:[1,2,3]}\n| .a # c',
    'if .a then {if: 1, end: 2} else .b end',
    'reduce .[] as $x (0; . + $x)',
    '[.x as $v |\ndef f: .a; f]',
    'try (.a | .b) catch ("err")',
    'label $out | break $out',
    '. as [$a, $b] ?// {$c} | .',
    '{(1 + 2): 3, $var: 4, "s": 5, if: 6, true: 7}'
  ]
  const tokTexts = (src: string) =>
    tokenize(src)
      .filter((t: { type: string }) => t.type !== 'comment')
      .map((t: { text: string }) => t.text)
  for (const s of samples) {
    assert.deepEqual(tokTexts(fmt(s)), tokTexts(s))
  }
})

test('broken input is left alone', () => {
  assert.throws(() => fmt('{"a": 1'), FormatError) // 括号不配对
  assert.throws(() => fmt('.a "unterminated'), FormatError) // 词法错误
  // 严格解析：语法非法的输入拒绝格式化（旧引擎只要求括号平衡）
  assert.throws(() => fmt('a = b = c'), FormatError) // nonassoc 链
  assert.throws(() => fmt('. foo'), FormatError) // 字段访问要求邻接
  assert.throws(() => fmt('{a: .x as $v | $v}'), FormatError) // 对象值不能含 as
  assert.throws(() => fmt('[1,]'), FormatError) // 数组不允许尾逗号
  assert.throws(() => fmt('if .a then 1'), FormatError) // 缺 end
})

test('CRLF is preserved in multiline output and EOF comments', () => {
  const src = 'def f: 1;\r\nf|.\r\n# tail\r\n'
  const expected = 'def f: 1;\r\nf | .\r\n# tail\r\n'
  assert.equal(fmt(src), expected)
  assert.equal(fmt(expected), expected)
})

test('structural EOL does not rewrite newlines inside opaque tokens', () => {
  const string = '"a\nb\r\nc"'
  const comment = '# comment \\\r\n  continuation'
  const src = `def f: ${string};\r\n${comment}\r\nf|. # end\r\n`
  const expected = `def f: ${string};\r\n${comment}\r\nf | . # end\r\n`
  assert.equal(fmt(src), expected)
  assert.equal(fmt(expected), expected)
  // 字符串内部的 CRLF 不应把外层 LF 改为 CRLF。
  assert.equal(fmt(`def f: ${string};\nf|.`), `def f: ${string};\nf | .\n`)
})

test('empty input', () => {
  assert.equal(fmt(''), '')
  assert.equal(fmt('   \n\t\n'), '   \n\t\n')
  // 纯注释文件原样保留
  assert.equal(fmt('# only\n# comments\n'), '# only\n# comments\n')
})
