import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { downloadAndUnzipVSCode } from '@vscode/test-electron'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const executable =
  process.env.VSCODE_EXECUTABLE_PATH ??
  (await downloadAndUnzipVSCode({
    version: manifest.engines.vscode.replace(/^\^/, ''),
    extensionDevelopmentPath: root,
    timeout: 60_000
  }))
const tempRoot = await realpath(tmpdir())
const sandbox = await mkdtemp(join(tempRoot, 'vscode-jq-test-'))

try {
  const folders = ['wide', 'narrow']
  for (const [i, folder] of folders.entries()) {
    const dir = join(sandbox, folder)
    await mkdir(join(dir, '.vscode'), { recursive: true })
    await writeFile(
      join(dir, '.vscode', 'settings.json'),
      JSON.stringify({ 'jq.format.indentSize': i === 0 ? 4 : 2 })
    )
    await writeFile(join(dir, 'format.jq'), '[\n1,\n2\n]\n')
  }
  await writeFile(join(sandbox, 'wide', 'enter.jq'), 'f( if .end then)\n')
  await writeFile(join(sandbox, 'wide', 'operand.jq'), '.x >=\n')
  await writeFile(join(sandbox, 'wide', 'object-colon.jq'), '{a:}\n')
  await writeFile(join(sandbox, 'wide', 'fallback.jq'), 'foo\n')
  const workspace = join(sandbox, 'test.code-workspace')
  await writeFile(
    workspace,
    JSON.stringify({
      folders: folders.map((path) => ({ path })),
      settings: {
        'jq.lsp.enabled': false,
        'workbench.startupEditor': 'none',
        '[jq]': { 'editor.tabSize': 6, 'editor.autoIndent': 'full' }
      }
    })
  )

  const userData = join(sandbox, 'user-data')
  const extensions = join(sandbox, 'extensions')
  await mkdir(join(userData, 'User'), { recursive: true })
  await mkdir(extensions)
  await writeFile(
    join(userData, 'User', 'settings.json'),
    JSON.stringify({ 'chat.disableAIFeatures': true })
  )

  const resultFile = join(sandbox, 'result.txt')
  const host = spawn(
    executable,
    [
      workspace,
      `--extensionDevelopmentPath=${root}`,
      `--extensionTestsPath=${join(root, 'out', 'test', 'extensionHost.js')}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extensions}`,
      '--disable-extensions',
      '--disable-gpu',
      '--disable-telemetry',
      '--disable-updates',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--no-sandbox'
    ],
    {
      env: { ...process.env, VSCODE_JQ_TEST_RESULT: resultFile },
      stdio: 'inherit',
      windowsHide: true
    }
  )
  const exit = once(host, 'exit').then(([code, signal]) => ({ code, signal }))
  const timer = new AbortController()
  try {
    const result = await Promise.race([
      waitForResult(resultFile, timer.signal),
      exit.then(() => readFile(resultFile, 'utf8')),
      delay(60_000, undefined, { signal: timer.signal }).then(() => {
        throw new Error('VS Code extension host did not report a test result within 60 seconds.')
      })
    ])
    if (result !== 'ok') throw new Error(result)
    const status = await Promise.race([exit, delay(5_000, null, { signal: timer.signal })])
    if (status === null) {
      // 断言已经通过，但有些 Electron 环境关闭窗口后仍不退出。只回收此处派生的实例。
      console.warn('VS Code did not exit after passing; stopping the isolated test instance.')
    } else if (status.code !== 0) {
      throw new Error(`VS Code exited with ${status.code ?? status.signal}.`)
    }
  } finally {
    timer.abort()
    if (host.exitCode === null && host.signalCode === null) host.kill()
    await exit.catch(() => {})
  }
} finally {
  // 只清理由本进程创建并验证过的测试目录，不碰安装的 VS Code 或个人设置。
  assert.equal(dirname(await realpath(sandbox)), tempRoot)
  await rm(sandbox, { force: true, recursive: true, maxRetries: 3 })
}

console.log(
  'VS Code extension host passed: scoped formatting, smart/native Enter, no tabSize writes.'
)

async function waitForResult(path: string, signal: AbortSignal): Promise<string> {
  for (;;) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await delay(100, undefined, { signal })
  }
}
