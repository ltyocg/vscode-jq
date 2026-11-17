/**
 * jqjq 语料回归：testdata/test.jq（jqjq.jq，三千余行真实世界的 jq
 * 代码）锁定格式化器的整体行为 —— 输出与 golden 逐字节一致，且幂等。
 *
 * golden 的再生成只允许一个途径：UPDATE_GOLDEN=1 pnpm test（仅在
 * 有意改变格式化行为时使用，并须与行为变更同一个提交）。重构期间
 * golden 出现 diff 即回归，绝不能靠重新生成"修绿"。
 *
 * 工作区检出可能是 CRLF（git index 存 LF、core.autocrlf 平台相关），
 * 两侧统一归一到 LF 再比较，golden 才是跨平台确定的；原始字节的
 * CRLF 保真路径由 index.test.ts 的「CRLF is preserved」覆盖。
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
  // 原始字节（本机为 CRLF）—— 覆盖 eol 检测路径
  const raw = readFileSync(corpusPath, 'utf8')
  const onceRaw = formatJq(raw)
  assert.equal(formatJq(onceRaw), onceRaw)
})

// 60/80/120 的幂等探针在规划阶段已人工验证通过；默认宽度（100）由
// 上面的测试覆盖。窄宽度下悬挂式判定的宽度测量路径有已知风格瑕疵，
// 不在本测试的锁定范围内。
