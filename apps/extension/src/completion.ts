import * as vscode from "vscode";
import { DaemonClient } from "./daemon-client.js";

export class AetherCompletionProvider
  implements vscode.InlineCompletionItemProvider
{
  constructor(
    private readonly daemonClient: DaemonClient,
    private readonly debounceMs: number = 150
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    // Check if cancellation was already requested
    if (token.isCancellationRequested) {
      return undefined;
    }

    // 1. Extract prefix (start of file to cursor) and suffix (cursor to end of file)
    const prefix = document.getText(
      new vscode.Range(new vscode.Position(0, 0), position)
    );

    const lastLine = document.lineCount - 1;
    const lastLineLength = document.lineAt(lastLine).text.length;
    const suffix = document.getText(
      new vscode.Range(
        position,
        new vscode.Position(lastLine, lastLineLength)
      )
    );

    // 2. 150ms debounce before firing network request
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve();
        }, this.debounceMs);

        token.onCancellationRequested(() => {
          clearTimeout(timer);
          reject(new vscode.CancellationError());
        });
      });
    } catch {
      return undefined;
    }

    if (token.isCancellationRequested) {
      return undefined;
    }

    // 3. Connect to daemon metadata
    const connInfo = this.daemonClient.getConnectionInfo();
    if (!connInfo) {
      return undefined;
    }

    // 4. Wire VS Code CancellationToken to AbortController for aggressive keystroke cancellation
    const abortController = new AbortController();
    const cancellationListener = token.onCancellationRequested(() => {
      abortController.abort();
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${connInfo.port}/v1/inline/completion`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${connInfo.token}`,
          },
          body: JSON.stringify({
            prefix,
            suffix,
            filepath: document.uri.fsPath,
            language: document.languageId,
          }),
          signal: abortController.signal,
        }
      );

      if (!response.ok || token.isCancellationRequested) {
        return undefined;
      }

      const data = (await response.json()) as { completion?: string };
      if (!data?.completion) {
        return undefined;
      }

      return [
        new vscode.InlineCompletionItem(
          data.completion,
          new vscode.Range(position, position)
        ),
      ];
    } catch {
      return undefined;
    } finally {
      cancellationListener.dispose();
    }
  }
}
