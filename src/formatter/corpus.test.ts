/**
 * jqjq 语料回归：testdata/test.jq（jqjq.jq，三千余行真实世界的 jq
 * 代码）锁定格式化器的整体行为 —— 输出与 golden 逐字节一致，且幂等。
 *
 * golden 的再生成只允许一个途径：UPDATE_GOLDEN=1 pnpm test（仅在
 * 有意改变格式化行为时使用，并须与行为变更同一个提交）。重构期间
 * golden 出现 diff 即回归，绝不能靠重新生成"修绿"。
 *
 * golden 以 LF 跨平台比较；额外构造 CRLF 语料，不依赖检出环境。
 * CRLF 与原始 token 字节混用由 index.test.ts 的独立用例覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatJq } from './index'

const root = join(__dirname, '..', '..')
const corpusPath = join(root, 'testdata', 'test.jq')
const goldenPath = join(root, 'testdata', 'test.formatted.jq')

const norm = (s: string): string => s.replace(/\r\n/g, '\n')

test('jqjq corpus: output matches the golden file byte for byte', () => {
  const src = norm(readFileSync(corpusPath, 'utf8'))
  const out = formatJq(src)
  if (process.env.UPDATE_GOLDEN) {
    writeFileSync(goldenPath, out)
    return
  }
  assert.equal(out, norm(readFileSync(goldenPath, 'utf8')))
})

test('jqjq corpus: formatting is idempotent', () => {
  // 归一化后的 LF 输入
  const src = norm(readFileSync(corpusPath, 'utf8'))
  const once = formatJq(src)
  assert.equal(formatJq(once), once)
  const crlf = (text: string): string => text.replace(/\n/g, '\r\n')
  const onceCrlf = formatJq(crlf(src))
  assert.equal(onceCrlf, crlf(once))
  assert.equal(formatJq(onceCrlf), onceCrlf)
})

test('jqjq corpus: formatting is idempotent across formatter options', () => {
  const src = norm(readFileSync(corpusPath, 'utf8'))
  for (const printWidth of [20, 60, 80, 100, 120]) {
    for (const indentSize of [1, 2, 4, 8]) {
      for (const trailingComma of ['never', 'multiline', 'preserve'] as const) {
        const options = { printWidth, indentSize, trailingComma }
        const once = formatJq(src, options)
        // 比较布尔值，失败时避免把整个三千行语料打印到日志。
        assert.ok(formatJq(once, options) === once, JSON.stringify(options))
      }
    }
  }
})
