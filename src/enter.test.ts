/**
 * 回车智能缩进的测试，▏ 标记光标。大部分期望值以格式化器的实际输出为
 * 准（oracle 语义）；例外是悬挂组——按「对齐眼前所见」对齐首元素实际
 * 列（紧贴 `{a:1,` 给 1、带空格 `{ a: 1,` 给 2），后续 format 再归一
 * 到格式化器的规范列（开括号列＋2）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { enterEdit, enterIndent } from './enter'
import { defaultFormatOptions } from './formatter'

const O = defaultFormatOptions

function at(marked: string): number | null {
  const cursor = marked.indexOf('▏')
  const src = marked.replace('▏', '')
  return enterIndent(src, cursor, O)
}

test('管道尾随 |：下一 token 是段内容（cont＋1 层）', () => {
  assert.equal(at('foo |▏'), 2)
  assert.equal(at('  map(.x) |▏'), 4)
})

test('def 冒号之后：体在 def 层＋1', () => {
  assert.equal(at('def f:▏'), 2)
  assert.equal(at('def f:\n  .x |▏'), 4)
})

test('`;` 之后一律是兄弟：语句回语句层，组内取元素层', () => {
  // 回退正则只看行首 def 关键字会错误 +1，这里必须给 0
  assert.equal(at('def double: . * 2;▏'), 0)
  // 多行 body 同样回到 0（formatter 对这种源码的真实输出）
  assert.equal(at('def f:\n  .x\n  | .y;▏'), 0)
  // 连续 def：同样回 0
  assert.equal(at('def f: .;\ndef g: .;▏'), 0)
  // import 结束：下一个 import／正文回 0（多行 import 不粘末行缩进）
  assert.equal(at('import "a" as b;▏'), 0)
  assert.equal(at('import "a"\n  as b;▏'), 0)
  // 组内 def 收尾：兄弟项对齐首元素（def 关键字）实际列
  assert.equal(at('map(def f: .;▏'), 4)
  // 参数表分隔：兄弟参数对齐首参数实际列（悬挂形态）
  assert.equal(at('def f(a;▏'), 6)
})

test('if 子句', () => {
  assert.equal(at('if .a then▏'), 2)
  // then 体完整收尾：elif/else/end 回到 if 关键字列
  assert.equal(at('if .a then .b▏'), 0)
  assert.equal(at('if .a▏'), 0)
  // 行中 if（'| ' 之后）：子句关键字对齐 if 列而非行缩进 —— 正则做不到
  assert.equal(at('  .x | if .a then .b▏'), 7)
})

test('括号组', () => {
  assert.equal(at('{▏'), 2)
  assert.equal(at('[▏'), 2)
  // 开括号起行：元素在 base＋1 层
  assert.equal(at('  foo(▏'), 4)
  // 悬挂组：续行对齐首元素实际列（紧贴给 1、带空格给 2）
  assert.equal(at('  foo(a▏'), 6)
  assert.equal(at('  foo(a,▏'), 6)
  assert.equal(at('{a: 1▏'), 1)
  assert.equal(at('{ a: 1▏'), 2)
  assert.equal(at('{a:▏'), 1)
})

test('嵌套组', () => {
  assert.equal(at('{\n  a: 1,\n  b: [▏'), 4)
})

test('as／label 绑定：答案对齐行首 | 的列', () => {
  assert.equal(at('. as $x▏'), 0)
  assert.equal(at('. as [$a] ?// [$b]▏'), 0)
  assert.equal(at('label $out▏'), 0)
  assert.equal(at('label $out |▏'), 2)
})

test('reduce／foreach', () => {
  // 行为组元素在关键字层＋1（分隔展开）
  assert.equal(at('reduce .[] as $x (▏'), 2)
  // `;` 之后是 update 部分：首部分已在开括号行上 → 悬挂对齐首部分列
  assert.equal(at('reduce .[] as $x (0;▏'), 18)
  // 组内已有完整部分但未到 `;`：不猜，回退
  assert.equal(at('reduce .[] as $x (0▏'), null)
})

test('try／catch／运算符', () => {
  assert.equal(at('try▏'), 2)
  assert.equal(at('.x +▏'), 2)
  assert.equal(at('1,▏'), 2)
})

test('组内完整元素（含 if）：悬挂对齐实际列', () => {
  assert.equal(at('[if .a then .b end▏'), 1)
  assert.equal(at('[ if .a then .b end▏'), 2)
})

test('光标后是闭括号：还在等内容给元素层，元素完整回基线层', () => {
  // 自动配全的经典流：敲 `{` 补 `}`，光标停在闭括号前继续写。
  // 悬挂组同样对齐首元素实际列（紧贴给 1、带空格给 2）
  assert.equal(at('{▏}'), 2)
  assert.equal(at('{a:▏}'), 1)
  assert.equal(at('{ a:▏}'), 2)
  assert.equal(at('{a: 1,▏}'), 1)
  assert.equal(at('{ a: 1,▏}'), 2)
  // 元素已完整：下一个只可能是 `,` 或闭括号 → 收括号（基线层）
  assert.equal(at('{a: 1▏}'), 0)
  assert.equal(at('[1, 2▏]'), 0)
  assert.equal(at('  foo(a▏)'), 2)
})

test('光标后是子句关键字：新行承接它们', () => {
  assert.equal(at('if a then b▏ else c end'), 0)
})

test('回退：残缺或未支持形态返回 null', () => {
  assert.equal(at('foo▏'), null)
  assert.equal(at('foo "unterminated▏'), null)
  assert.equal(at('foo | # 注释▏'), null)
  assert.equal(at('▏'), null)
  // 光标不在最后一个实 token 所在行（空行上的回车）
  assert.equal(at('foo |\n  ▏'), null)
})

function applyEnter(marked: string, indentSize = 2, insertSpaces = true, tabSize = 2) {
  const cursor = marked.indexOf('▏')
  const src = marked.replace('▏', '')
  const edit = enterEdit(src, cursor, { ...O, indentSize }, insertSpaces, tabSize)
  if (edit === null) return null
  return src.slice(0, edit.start) + edit.beforeCursor + '▏' + edit.afterCursor + src.slice(edit.end)
}

test('空括号对：闭括号另起一行，光标留在缩进后的空行', () => {
  assert.equal(applyEnter('{▏}'), '{\n  ▏\n}')
  assert.equal(applyEnter('[▏]'), '[\n  ▏\n]')
  assert.equal(applyEnter('f(▏)'), 'f(\n  ▏\n)')
  assert.equal(applyEnter('map([▏])'), 'map([\n  ▏\n])')
  assert.equal(applyEnter('{\n  a: [  ▏\t ]\n}'), '{\n  a: [\n    ▏\n  ]\n}')
  assert.equal(applyEnter('  {▏}', 4), '  {\n      ▏\n  }')
  assert.equal(applyEnter('\t{▏}', 4, false, 4), '\t{\n\t\t▏\n\t}')
})

test('非空或不匹配的括号不插入额外空行', () => {
  assert.equal(applyEnter('{a: 1▏}'), '{a: 1\n▏}')
  assert.equal(applyEnter('{▏a: 1}'), '{\n  ▏a: 1}')
  assert.equal(applyEnter('{▏]'), '{\n  ▏]')
  assert.equal(applyEnter('{▏\n}'), '{\n  ▏\n}')
  assert.equal(applyEnter('"{▏}"'), null)
  assert.equal(applyEnter('# {▏}'), null)
})
