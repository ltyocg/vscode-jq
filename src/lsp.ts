/**
 * Language server integration for jq-lsp (github.com/wader/jq-lsp).
 *
 * jq-lsp provides diagnostics, completion, hover and go-to-definition.
 * It deliberately does NOT provide textDocument/formatting — its parser
 * discards whitespace and comments — so document formatting stays with
 * the built-in formatter in ./formatter. The two coexist: this client
 * only claims the features the server actually implements.
 */

import * as vscode from 'vscode'
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node'
import { findExecutable } from './which'

export interface LspStartResult {
  /** the started client, when one was */
  client?: LanguageClient
  /** human-readable reason the server was not started */
  reason?: string
}

export function startJqLsp(log: vscode.LogOutputChannel): LspStartResult {
  const cfg = vscode.workspace.getConfiguration('jq.lsp')
  if (!cfg.get<boolean>('enabled', true)) {
    return { reason: 'disabled by jq.lsp.enabled' }
  }

  const command = cfg.get<string>('path', 'jq-lsp')
  const resolved = findExecutable(command)
  if (!resolved) {
    const reason =
      `jq-lsp not found (looked for "${command}" on PATH). ` +
      'Install it with `brew install jq-lsp` or ' +
      '`go install github.com/wader/jq-lsp@latest`, or set "jq.lsp.path" ' +
      'to the absolute path of the binary. Diagnostics and completion are ' +
      'disabled until then; formatting keeps working.'
    log.warn(reason)
    return { reason }
  }

  log.info(`starting language server: ${resolved}`)
  const serverOptions: ServerOptions = {
    run: { command: resolved, options: { env: process.env } },
    debug: { command: resolved, options: { env: { ...process.env, DEBUG: '1' } } }
  }
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { language: 'jq', scheme: 'file' },
      { language: 'jq', scheme: 'untitled' }
    ],
    outputChannelName: 'jq-lsp'
  }

  const client = new LanguageClient('jqlsp', 'jq-lsp', serverOptions, clientOptions)
  client.start().then(
    () => log.info('jq-lsp started'),
    (err: unknown) => log.error(`jq-lsp failed to start: ${String(err)}`)
  )
  return { client }
}
