import * as vscode from 'vscode'
import {
  defaultFormatOptions,
  formatJq,
  FormatError,
  type FormatOptions,
  type TrailingCommaMode
} from './formatter'
import { enterEdit, maxEnterPrefixLength } from './enter'
import { startJqLsp } from './lsp'
import type { LanguageClient } from 'vscode-languageclient/node'

const LOG = vscode.window.createOutputChannel('jq', { log: true })

let lspClient: LanguageClient | undefined

export function activate(context: vscode.ExtensionContext): void {
  // -- formatter (built-in, independent of the language server) -------------
  const formatOptions = (document: vscode.TextDocument): FormatOptions => {
    const cfg = vscode.workspace.getConfiguration('jq.format', document)
    return {
      printWidth: cfg.get<number>('printWidth', defaultFormatOptions.printWidth),
      indentSize: cfg.get<number>('indentSize', defaultFormatOptions.indentSize),
      trailingComma: cfg.get<TrailingCommaMode>('trailingComma', defaultFormatOptions.trailingComma)
    }
  }

  const provider: vscode.DocumentFormattingEditProvider = {
    provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
      const text = document.getText()
      let formatted: string
      try {
        formatted = formatJq(text, formatOptions(document))
      } catch (e) {
        if (e instanceof FormatError) {
          // Don't touch files we cannot parse — but say so visibly.
          // A silent [] looks like "nothing to format" and hides the cause.
          LOG.error(e.message)
          void vscode.window
            .showWarningMessage(`jq format: ${e.message}`, 'Show Log')
            .then((pick) => {
              if (pick === 'Show Log') LOG.show()
            })
          return []
        }
        throw e
      }
      if (formatted === text) return []
      const whole = new vscode.Range(document.positionAt(0), document.positionAt(text.length))
      return [vscode.TextEdit.replace(whole, formatted)]
    }
  }

  // -- language server (diagnostics, completion, hover, definitions) --------
  const lsp = startJqLsp(LOG)
  lspClient = lsp.client
  if (lsp.client) {
    context.subscriptions.push({
      dispose: () => void lspClient?.stop()
    })
  } else if (lsp.reason && !lsp.reason.startsWith('disabled')) {
    // Server binary missing: tell the user how to get it (once per window).
    void vscode.window.showInformationMessage(lsp.reason)
  }

  // -- smart Enter (formatter-aligned indentation) --------------------------
  // VS Code 没有按语法算回车缩进的钩子（indentationRules 只有正则、只能
  // ±1 级）。这里拦截 jq 文件的回车，按当前构造的基准列计算缩进；
  //（src/enter.ts）算不出时回退默认回车，语言配置里的正则缩进规则
  // 照常兜底。
  // 回退走 `default:type` 携 "\n"：核心 type 管线的第一个拦截就是
  // EnterOperation（getEnterAction／getIndentForEnter），等价于原生
  // 回车；`default:` 前缀只对 type／cut／paste 等核心命令有注册，
  // 不存在 `default:enter`。
  const fallbackEnter = (): Thenable<unknown> =>
    vscode.commands.executeCommand('default:type', { text: '\n' })
  const smartEnter = async (): Promise<unknown> => {
    const editor = vscode.window.activeTextEditor
    if (editor === undefined || editor.document.languageId !== 'jq') return fallbackEnter()
    // 多光标／选区／只读／显式关闭智能缩进：交给默认行为
    if (editor.selections.length !== 1 || !editor.selection.isEmpty) return fallbackEnter()
    const auto = vscode.workspace
      .getConfiguration('editor', editor.document)
      .get<string>('autoIndent')
    if (auto === 'none' || auto === 'keep') return fallbackEnter()
    const doc = editor.document
    const cursor = editor.selection.active
    const lineEnd = doc.lineAt(cursor.line).range.end
    if (doc.offsetAt(lineEnd) > maxEnterPrefixLength) return fallbackEnter()
    const { insertSpaces, tabSize } = editor.options
    const edit = enterEdit(
      doc.getText(new vscode.Range(new vscode.Position(0, 0), lineEnd)),
      doc.offsetAt(cursor),
      formatOptions(doc),
      insertSpaces !== false,
      typeof tabSize === 'number' ? Math.max(1, tabSize) : 2
    )
    if (edit === null) return fallbackEnter()
    const snippet = new vscode.SnippetString().appendText(edit.beforeCursor)
    if (edit.afterCursor) snippet.appendTabstop(0).appendText(edit.afterCursor)
    const range = new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end))
    const inserted = await editor.insertSnippet(snippet, range, {
      undoStopBefore: true,
      undoStopAfter: true,
      keepWhitespace: true
    })
    return inserted ? undefined : fallbackEnter()
  }

  context.subscriptions.push(
    LOG,
    vscode.languages.registerDocumentFormattingEditProvider('jq', provider),
    vscode.commands.registerCommand('jq.enter', smartEnter)
  )
}

export function deactivate(): Thenable<void> | undefined {
  return lspClient?.stop()
}
