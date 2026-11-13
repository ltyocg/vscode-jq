import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatJq, FormatError } from '../formatter';

const fmt = (src: string, printWidth = 80) => formatJq(src, { printWidth });

test('normalizes spacing around operators', () => {
  assert.equal(fmt('.a|.b'), '.a | .b\n');
  assert.equal(fmt('.a  +   .b'), '.a + .b\n');
  assert.equal(fmt('1==2'), '1 == 2\n');
  assert.equal(fmt('.a // .b'), '.a // .b\n');
  assert.equal(fmt('.x as $v|$v'), '.x as $v | $v\n');
});

test('field access and indexing stay tight', () => {
  assert.equal(fmt('.a.b.c'), '.a.b.c\n');
  assert.equal(fmt('.a [ 0 ]'), '.a[0]\n');
  assert.equal(fmt('.["foo"]'), '.["foo"]\n');
  assert.equal(fmt('."foo"'), '."foo"\n');
  assert.equal(fmt('.a[]?'), '.a[]?\n');
  assert.equal(fmt('first[0]'), 'first[0]\n');
  assert.equal(fmt('$x.y'), '$x.y\n');
  assert.equal(fmt('map(.a)'), 'map(.a)\n');
});

test('unary minus', () => {
  assert.equal(fmt('{a: -1}'), '{a: -1}\n');
  assert.equal(fmt('[-1, -2]'), '[-1, -2]\n');
  assert.equal(fmt('f(-1)'), 'f(-1)\n');
  assert.equal(fmt('1 - 2'), '1 - 2\n');
  assert.equal(fmt('.[1:-1]'), '.[1:-1]\n');
  assert.equal(fmt('.[2:5]'), '.[2:5]\n');
});

test('literals, variables, formats, constants', () => {
  assert.equal(fmt('$__loc__'), '$__loc__\n');
  assert.equal(fmt('@base64 "x"'), '@base64 "x"\n');
  assert.equal(fmt('true and false or null'), 'true and false or null\n');
  assert.equal(fmt('1.5e10'), '1.5e10\n');
});

test('string interpolation kept verbatim', () => {
  const src = '"a \\(1 + 2) b"';
  assert.equal(fmt(src), src + '\n');
});

test('def formatting', () => {
  assert.equal(fmt('def f(a;b):.a|f;'), 'def f(a; b): .a | f;\n');
  assert.equal(
    fmt('def f: .a | .b; .f'),
    'def f: .a | .b;\n.f\n',
  );
  // blank line between defs is preserved (max one)
  assert.equal(
    fmt('def f: .a;\n\n\ndef g: .b;\n.f'),
    'def f: .a;\n\ndef g: .b;\n.f\n',
  );
});

test('if/elif/else/end clauses', () => {
  assert.equal(
    fmt('if .a then .b else .c end'),
    'if .a then .b else .c end\n',
  );
  const src = [
    'if .a',
    'then .b',
    'elif .c',
    'then .d',
    'else .e',
    'end',
  ].join('\n');
  assert.equal(fmt(src), src + '\n');
});

test('try/catch', () => {
  assert.equal(fmt('try .a catch .b'), 'try .a catch .b\n');
  const src = 'try .a\ncatch .b';
  assert.equal(fmt(src), 'try .a\ncatch .b\n');
});

test('reduce / foreach / label / break', () => {
  assert.equal(
    fmt('reduce .[] as $x (0; . + $x)'),
    'reduce .[] as $x (0; . + $x)\n',
  );
  assert.equal(
    fmt('foreach .[] as $x (0; . + $x; . * 2)'),
    'foreach .[] as $x (0; . + $x; . * 2)\n',
  );
  assert.equal(
    fmt('label $out | .[] | if . then . else break $out end'),
    'label $out | .[] | if . then . else break $out end\n',
  );
  assert.equal(
    fmt('. as [$a] ?// {$b} | $a'),
    '. as [$a] ?// {$b} | $a\n',
  );
});

test('object construction', () => {
  assert.equal(fmt('{a: 1, "b": 2, $c}'), '{a: 1, "b": 2, $c}\n');
  assert.equal(fmt('{if: 1, end: 2}'), '{if: 1, end: 2}\n');
  const src = '{\n  "a": 1,\n  "b": 2\n}';
  assert.equal(fmt(src), src + '\n');
  // comments force expansion
  assert.equal(
    fmt('{a: 1, # first\nb: 2}'),
    '{\n  a: 1,  # first\n  b: 2\n}\n',
  );
});

test('import / include / module', () => {
  assert.equal(
    fmt('module {name: "x"}; import "a" as b; include "c"; .'),
    'module {name: "x"};\nimport "a" as b;\ninclude "c";\n.\n',
  );
});

test('pipeline breaks with leading pipe when too long', () => {
  const out = fmt('.aaaaaaaaaaaa | .bbbbbbbbbbbb | .cccccccccccc', 20);
  assert.equal(
    out,
    '.aaaaaaaaaaaa\n  | .bbbbbbbbbbbb\n  | .cccccccccccc\n',
  );
});

test('source line breaks in pipelines are preserved', () => {
  assert.equal(fmt('.a\n| .b'), '.a\n  | .b\n');
});

test('groups expand when they do not fit', () => {
  const src = '{"aaaaaaaaaa": 1, "bbbbbbbbbb": 2, "cccccccccc": 3}';
  const out = fmt(src, 40);
  assert.equal(
    out,
    '{\n  "aaaaaaaaaa": 1,\n  "bbbbbbbbbb": 2,\n  "cccccccccc": 3\n}\n',
  );
});

test('expanded paren groups (reduce)', () => {
  const src = 'reduce .[] as $x (\n  0;\n  . + $x\n)';
  assert.equal(fmt(src), src + '\n');
});

test('comments', () => {
  assert.equal(
    fmt('# header\n.a # trailing\n'),
    '# header\n.a  # trailing\n',
  );
  assert.equal(
    fmt('.a | # note\n.b'),
    '.a |  # note\n  .b\n',
  );
});

test('group opened on a pipe-continuation line indents from that line', () => {
  // A group whose opener sits on the '| ...' continuation line (indent 1)
  // bases its contents one level deeper than that line, closers back on it.
  assert.equal(
    fmt('.a\n| map({\n  b: 1\n})'),
    '.a\n  | map(\n    {\n      b: 1\n    }\n  )\n',
  );
  assert.equal(
    fmt('.a\n| {\n  b: 1\n}'),
    '.a\n  | {\n    b: 1\n  }\n',
  );
});

test('idempotency', () => {
  const samples = [
    'def f(a;b):.a|f;\n.x as $v|$v|f(1;2)',
    '{a:1,b:[1,2,3]}\n| .a',
    'if .a then .b else .c end',
    'reduce .[] as $x (0; . + $x)',
    '# c\n.foo | .bar # d\n| .baz',
    'try (.a | .b) catch ("err: \\(.)")',
    'label $out | foreach .[] as $x (0; .+1; if . > 3 then break $out else . end)',
  ];
  for (const s of samples) {
    const once = fmt(s);
    assert.equal(fmt(once), once, `not idempotent for: ${s}`);
  }
});

test('broken input is left alone', () => {
  const bad = '{"a": 1'; // unbalanced
  assert.throws(() => fmt(bad), FormatError);
  assert.throws(() => fmt('.a "unterminated'), FormatError);
});

test('CRLF is preserved', () => {
  assert.equal(fmt('.a | .b\r\n'), '.a | .b\r\n');
});

test('empty input', () => {
  assert.equal(fmt(''), '');
  assert.equal(fmt('   \n\t\n'), '   \n\t\n');
});
