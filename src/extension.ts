import * as vscode from 'vscode'
import { formatJq, FormatError, FormatOptions, TrailingCommaMode } from './formatter'
import { startJqLsp } from './lsp'
import type { LanguageClient } from 'vscode-languageclient/node'

const LOG = vscode.window.createOutputChannel('jq', { log: true })

let lspClient: LanguageClient | undefined

export function activate(context: vscode.ExtensionContext): void {
  // -- formatter (built-in, independent of the language server) -------------
  const formatOptions = (): FormatOptions => {
    const cfg = vscode.workspace.getConfiguration('jq.format')
    return {
      printWidth: cfg.get<number>('printWidth', 100),
      indentSize: cfg.get<number>('indentSize', 2),
      trailingComma: cfg.get<TrailingCommaMode>('trailingComma', 'never')
    }
  }

  const provider: vscode.DocumentFormattingEditProvider = {
    provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
      const text = document.getText()
      let formatted: string
      try {
        formatted = formatJq(text, formatOptions())
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

  context.subscriptions.push(
    LOG,
    vscode.languages.registerDocumentFormattingEditProvider('jq', provider)
  )
}

export function deactivate(): Thenable<void> | undefined {
  return lspClient?.stop()
}
