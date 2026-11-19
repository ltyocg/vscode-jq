import assert from 'node:assert/strict'
import { rename, writeFile } from 'node:fs/promises'
import * as vscode from 'vscode'

export async function run(): Promise<void> {
  const resultFile = process.env.VSCODE_JQ_TEST_RESULT
  assert.ok(resultFile)
  let result = 'ok'
  try {
    try {
      await testFormattingAndEnter()
    } finally {
      // 所有文件都在临时工作区，保存避免宿主退出时出现未保存确认框。
      await vscode.workspace.saveAll(false)
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    }
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    result = `Extension host assertions failed:\n${detail}`
    throw error
  } finally {
    // 先写再原子更名，启动器不会误读到部分结果。
    await writeFile(`${resultFile}.tmp`, result)
    await rename(`${resultFile}.tmp`, resultFile)
  }
}

async function testFormattingAndEnter(): Promise<void> {
  const extension = vscode.extensions.getExtension('gigaplant.vscode-jq')
  assert.ok(extension)
  await extension.activate()

  const roots = vscode.workspace.workspaceFolders
  assert.ok(roots)
  assert.deepEqual(
    roots.map((root) => root.name),
    ['wide', 'narrow']
  )

  const open = (file: string, folder = 0): Thenable<vscode.TextDocument> =>
    vscode.workspace.openTextDocument(vscode.Uri.joinPath(roots[folder]!.uri, file))

  // 同一个 VS Code 窗口里的两个工作区文件夹可各自指定格式化缩进。
  for (const [i, spaces] of [4, 2].entries()) {
    const doc = await open('format.jq', i)
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      'vscode.executeFormatDocumentProvider',
      doc.uri,
      { tabSize: 6, insertSpaces: true }
    )
    const indent = ' '.repeat(spaces)
    const workspaceEdit = new vscode.WorkspaceEdit()
    workspaceEdit.set(doc.uri, edits)
    assert.ok(await vscode.workspace.applyEdit(workspaceEdit))
    assert.equal(doc.getText(), `[\n${indent}1,\n${indent}2\n]\n`)
  }

  async function pressEnter(
    file: string,
    expected: string,
    character?: number
  ): Promise<vscode.TextEditor> {
    const doc = await open(file)
    const editor = await vscode.window.showTextDocument(doc)
    const caret =
      character === undefined ? doc.lineAt(0).range.end : new vscode.Position(0, character)
    editor.selection = new vscode.Selection(caret, caret)
    await vscode.commands.executeCommand('jq.enter')
    assert.equal(doc.getText(), expected)
    return editor
  }

  // 关键字字段仍走智能缩进；无法判定的普通表达式交给 VS Code 原生回车。
  const smart = await pressEnter('enter.jq', 'f( if .end then\n       )\n', 15)
  assert.deepEqual([smart.selection.active.line, smart.selection.active.character], [1, 7])
  const operand = await pressEnter('operand.jq', '.x >=\n    \n')
  assert.deepEqual([operand.selection.active.line, operand.selection.active.character], [1, 4])
  const object = await pressEnter('object-colon.jq', '{a:\n     }\n', 3)
  assert.deepEqual([object.selection.active.line, object.selection.active.character], [1, 5])
  const native = await pressEnter('fallback.jq', 'foo\n\n')
  assert.deepEqual([native.selection.active.line, native.selection.active.character], [1, 0])

  // 激活、格式化和回车都不应覆盖编辑器选项，也不应持久写入用户/工作区设置。
  for (const i of [0, 1]) {
    const doc = await open('format.jq', i)
    const editor = await vscode.window.showTextDocument(doc)
    const tabSize = vscode.workspace.getConfiguration('editor', doc).inspect<number>('tabSize')
    assert.equal(editor.options.tabSize, 6)
    assert.equal(tabSize?.workspaceLanguageValue, 6)
    assert.equal(tabSize?.workspaceFolderLanguageValue, undefined)
    assert.equal(tabSize?.globalLanguageValue, undefined)
  }
}
