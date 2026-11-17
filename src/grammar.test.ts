/**
 * Grammar tests: run the TextMate grammar through vscode-textmate and
 * assert the scopes it produces for jq constructs whose highlighting
 * depends on non-trivial regexes (comment continuation, number forms,
 * escapes, builtins).
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Registry, parseRawGrammar, INITIAL } from 'vscode-textmate'
import type { IGrammar, StateStack } from 'vscode-textmate'
import { loadWASM, createOnigScanner, createOnigString } from 'vscode-oniguruma'

interface Tok {
  line: number
  text: string
  scopes: string[]
}

let grammar: IGrammar

before(async () => {
  await loadWASM(fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')))
  const registry = new Registry({
    onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
    loadGrammar: async (scopeName) =>
      scopeName === 'source.jq'
        ? parseRawGrammar(
            fs.readFileSync(path.join(__dirname, '..', 'syntaxes', 'jq.tmLanguage.json'), 'utf-8'),
            'jq.tmLanguage.json'
          )
        : null
  })
  grammar = (await registry.loadGrammar('source.jq'))!
})

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let stack: StateStack = INITIAL
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const r = grammar.tokenizeLine(lines[i], stack)
    stack = r.ruleStack
    for (const t of r.tokens) {
      out.push({ line: i, text: lines[i].slice(t.startIndex, t.endIndex), scopes: t.scopes })
    }
  }
  return out
}

/** All tokens on 0-based line `n` that are not pure whitespace. */
const toks = (src: string, n: number) =>
  tokenize(src).filter((t) => t.line === n && t.text.trim() !== '')

test('plain comment ends at end of line', () => {
  const ts = toks('# hello\n. as $x | $x', 0)
  assert.equal(ts.length, 2)
  assert.match(ts[0].scopes.join(' '), /comment\.line\.number-sign\.jq/)
})

test('odd trailing backslash continues the comment (jq 1.8 spec)', () => {
  const src = '# cont \\\nstill comment\n. as $x | $x\n'
  // line 1 is part of the comment
  const l1 = toks(src, 1)
  assert.equal(l1.length, 1)
  assert.match(l1[0].scopes.join(' '), /comment\.line\.number-sign\.jq/)
  // line 2 is code again
  const l2 = toks(src, 2)
  assert.ok(l2.some((t) => t.scopes.includes('keyword.control.jq')))
})

test('even trailing backslash does not continue the comment', () => {
  const src = '# cont \\\\\nthis is code\n'
  const l1 = toks(src, 1)
  assert.ok(l1.length > 0)
  assert.ok(!l1.some((t) => t.scopes.some((s) => s.startsWith('comment'))))
})

test('consecutive continuations chain', () => {
  const src = '# a \\\n# b \\\nthird line\n. as $x | $x\n'
  for (const n of [1, 2]) {
    const t = toks(src, n)
    assert.equal(t.length, 1)
    assert.match(t[0].scopes.join(' '), /comment\.line\.number-sign\.jq/, `line ${n}`)
  }
})

test('trailing comment continuation swallows the next line', () => {
  const src = '[.[]] # c \\\n, 99 is comment ]\n'
  const l1 = toks(src, 1)
  assert.equal(l1.length, 1)
  assert.match(l1[0].scopes.join(' '), /comment\.line\.number-sign\.jq/)
})

test('comment continuation works inside string interpolation', () => {
  const src = '"a \\( # note \\\nswallowed ) b"\n'
  const l1 = toks(src, 1)
  assert.ok(l1.some((t) => t.scopes.includes('comment.line.number-sign.jq')))
})

test('leading-dot number literals', () => {
  const src = '.5 + .5e2 + 1. + 1.5'
  const nums = tokenize(src).filter((t) => t.text.match(/^[.0-9]/))
  assert.deepEqual(
    nums.map((t) => t.text),
    ['.5', '.5e2', '1.', '1.5']
  )
  for (const t of nums) assert.ok(t.scopes.includes('constant.numeric.jq'), t.text)
})

test('dot access is not confused with leading-dot numbers', () => {
  const src = '.a | .[] | ."x" | .b'
  assert.ok(!tokenize(src).some((t) => t.scopes.includes('constant.numeric.jq')))
})

test('invalid string escapes are marked illegal', () => {
  const src = '"\\a" + "\\n" + "\\(1)"'
  const ts = tokenize(src)
  const bad = ts.find((t) => t.text === '\\a')
  assert.ok(bad?.scopes.includes('invalid.illegal.escape.jq'))
  const good = ts.find((t) => t.text === '\\n')
  assert.ok(good?.scopes.includes('constant.character.escape.jq'))
  assert.ok(ts.some((t) => t.scopes.includes('meta.embedded.jq')))
})

test('jq 1.8 builtins are highlighted', () => {
  const src = 'pick(.a) | trim | toboolean | have_decnum | walk(.)'
  for (const name of ['pick', 'trim', 'toboolean', 'have_decnum', 'walk']) {
    const t = tokenize(src).find((tk) => tk.text === name)
    assert.ok(t?.scopes.includes('support.function.builtin.jq'), name)
  }
})

test('SQL-style builtins and math builtins', () => {
  const src = 'INDEX(.a) | IN(1) | JOIN($x) | tgamma(2) | combinations'
  for (const name of ['INDEX', 'IN', 'JOIN', 'tgamma', 'combinations']) {
    const t = tokenize(src).find((tk) => tk.text === name)
    assert.ok(t?.scopes.includes('support.function.builtin.jq'), name)
  }
})

test('keyword-named fields after a dot are identifiers', () => {
  const src = '{if: 1} | .if | .null'
  const ts = tokenize(src)
  // the object key `if` is a keyword, but `.if` / `.null` are field names
  assert.ok(ts.some((t) => t.text === 'if' && t.scopes.includes('keyword.control.jq')))
  assert.ok(ts.some((t) => t.text === 'if' && t.scopes.includes('meta.identifier.jq')))
  assert.ok(ts.some((t) => t.text === 'null' && t.scopes.includes('meta.identifier.jq')))
})

test('def after a pipe still gets entity.name.function', () => {
  const src = '1 | def f: .; f'
  const t = tokenize(src).find(
    (tk) => tk.text === 'f' && tk.scopes.includes('entity.name.function.jq')
  )
  assert.ok(t)
})
