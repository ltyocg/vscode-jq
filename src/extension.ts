import * as vscode from 'vscode';
import { formatJq, FormatError, FormatOptions } from './formatter';

const LOG = vscode.window.createOutputChannel('jq', { log: true });

export function activate(context: vscode.ExtensionContext): void {
  const formatOptions = (): FormatOptions => {
    const cfg = vscode.workspace.getConfiguration('jq.format');
    return {
      printWidth: cfg.get<number>('printWidth', 80),
      indentSize: cfg.get<number>('indentSize', 2),
    };
  };

  const provider: vscode.DocumentFormattingEditProvider = {
    provideDocumentFormattingEdits(document: vscode.TextDocument):
      vscode.TextEdit[] {
      const text = document.getText();
      let formatted: string;
      try {
        formatted = formatJq(text, formatOptions());
      } catch (e) {
        if (e instanceof FormatError) {
          // Don't touch files we cannot parse — just report why.
          LOG.error(e.message);
          return [];
        }
        throw e;
      }
      if (formatted === text) return [];
      const whole = new vscode.Range(
        document.positionAt(0),
        document.positionAt(text.length),
      );
      return [vscode.TextEdit.replace(whole, formatted)];
    },
  };

  context.subscriptions.push(
    LOG,
    vscode.languages.registerDocumentFormattingEditProvider('jq', provider),
  );
}

export function deactivate(): void {}
