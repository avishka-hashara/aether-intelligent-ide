import * as vscode from "vscode";
import { DaemonClient } from "./daemon-client.js";
import { InlineDiffManager } from "./inline-diff.js";

let defaultDiffManager: InlineDiffManager | null = null;

/**
 * Prompts user for an instruction on the selected lines, requests an inline edit diff
 * from the Aether daemon, applies the diff with visual decorations, and allows accepting
 * or rejecting the modification.
 */
export async function executeInlineEdit(
  daemonClient: DaemonClient,
  diffManager?: InlineDiffManager
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const instruction = await vscode.window.showInputBox({
    prompt: "Instruct Aether (e.g., 'make this function async')",
  });

  if (!instruction || !instruction.trim()) {
    return;
  }

  const fileContent = editor.document.getText();
  const selectionStartLine = editor.selection.start.line + 1;
  const selectionEndLine = editor.selection.end.line + 1;
  const filepath = editor.document.uri.fsPath;

  const connInfo = daemonClient.getConnectionInfo();
  if (!connInfo) {
    vscode.window.showErrorMessage("Aether Daemon is not running or connected.");
    return;
  }

  const manager = diffManager ?? (defaultDiffManager ??= new InlineDiffManager());

  let diffResult: string | null = null;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Aether is editing...",
      cancellable: true,
    },
    async (_progress, token) => {
      const abortController = new AbortController();
      token.onCancellationRequested(() => {
        abortController.abort();
      });

      try {
        const response = await fetch(
          `http://127.0.0.1:${connInfo.port}/v1/inline/edit`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${connInfo.token}`,
            },
            body: JSON.stringify({
              filepath,
              instruction: instruction.trim(),
              fileContent,
              selectionStartLine,
              selectionEndLine,
            }),
            signal: abortController.signal,
          }
        );

        if (!response.ok) {
          const errData = (await response.json().catch(() => ({}))) as any;
          throw new Error(
            errData?.message || `Daemon returned HTTP ${response.status}`
          );
        }

        const data = (await response.json()) as { diff?: string };
        if (data && typeof data.diff === "string") {
          diffResult = data.diff;
        }
      } catch (err: any) {
        if (token.isCancellationRequested) {
          return;
        }
        vscode.window.showErrorMessage(
          `Aether inline edit failed: ${err?.message || err}`
        );
      }
    }
  );

  if (!diffResult) {
    return;
  }

  const applied = await manager.applyAndRenderDiff(editor, diffResult);
  if (!applied) {
    vscode.window.showWarningMessage("Aether could not apply the generated diff.");
    return;
  }

  const decision = await vscode.window.showInformationMessage(
    "Accept changes?",
    "Accept",
    "Reject"
  );

  if (decision === "Reject") {
    await vscode.commands.executeCommand("undo");
  }

  manager.clearDecorations(editor);
}
