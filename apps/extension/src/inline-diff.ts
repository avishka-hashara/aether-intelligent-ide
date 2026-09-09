import * as vscode from "vscode";
import { parsePatch, applyPatch } from "diff";

export class InlineDiffManager implements vscode.Disposable {
  readonly addedDecoration: vscode.TextEditorDecorationType;
  readonly removedDecoration: vscode.TextEditorDecorationType;

  constructor() {
    this.addedDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(0, 255, 0, 0.2)",
      isWholeLine: true,
    });

    this.removedDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(255, 0, 0, 0.2)",
      textDecoration: "line-through",
      isWholeLine: true,
    });
  }

  /**
   * Parses the unified diff string, applies the patch to the active text editor,
   * and highlights added/modified lines.
   */
  async applyAndRenderDiff(
    editor: vscode.TextEditor,
    diffString: string
  ): Promise<boolean> {
    let cleanDiff = diffString.trim();
    if (!cleanDiff) {
      return false;
    }

    // Ensure unified diff header if missing for parsePatch compatibility
    if (!cleanDiff.includes("---") && !cleanDiff.includes("+++")) {
      cleanDiff = `--- a/file\n+++ b/file\n${cleanDiff}`;
    }

    let patches = parsePatch(cleanDiff);
    if (!patches || patches.length === 0 || !patches[0].hunks || patches[0].hunks.length === 0) {
      const syntheticDiff = `--- a/file\n+++ b/file\n${cleanDiff}`;
      const fallbackPatches = parsePatch(syntheticDiff);
      if (fallbackPatches && fallbackPatches.length > 0 && fallbackPatches[0].hunks.length > 0) {
        patches = fallbackPatches;
        cleanDiff = syntheticDiff;
      } else {
        return false;
      }
    }

    const currentContent = editor.document.getText();
    let newContent: string | boolean = applyPatch(currentContent, cleanDiff);

    if (typeof newContent !== "string") {
      newContent = applyPatch(currentContent, patches[0], { fuzzFactor: 2 });
    }

    // Apply patch logic via editor.edit
    const success = await editor.edit((editBuilder) => {
      if (typeof newContent === "string") {
        const fullRange = new vscode.Range(
          new vscode.Position(0, 0),
          new vscode.Position(
            editor.document.lineCount - 1,
            editor.document.lineAt(editor.document.lineCount - 1).text.length
          )
        );
        editBuilder.replace(fullRange, newContent);
      } else {
        // Fallback: apply hunks in reverse line order
        const sortedHunks = [...patches[0].hunks].sort((a, b) => b.oldStart - a.oldStart);
        for (const hunk of sortedHunks) {
          const startLine = Math.max(0, hunk.oldStart - 1);
          const endLine = Math.min(
            editor.document.lineCount - 1,
            startLine + Math.max(0, hunk.oldLines - 1)
          );
          const replacementText = hunk.lines
            .filter((l) => !l.startsWith("-"))
            .map((l) => l.slice(1))
            .join("\n");
          const replaceRange = new vscode.Range(
            new vscode.Position(startLine, 0),
            new vscode.Position(
              endLine,
              editor.document.lineAt(endLine).text.length
            )
          );
          editBuilder.replace(replaceRange, replacementText);
        }
      }
    });

    if (!success) {
      return false;
    }

    // Calculate added/modified ranges in the document
    const addedRanges: vscode.Range[] = [];

    for (const hunk of patches[0].hunks) {
      let currentNewLine = hunk.newStart;
      for (const line of hunk.lines) {
        if (line.startsWith("+")) {
          const lineIdx = currentNewLine - 1;
          if (lineIdx >= 0 && lineIdx < editor.document.lineCount) {
            const lineLen = editor.document.lineAt(lineIdx).text.length;
            addedRanges.push(
              new vscode.Range(
                new vscode.Position(lineIdx, 0),
                new vscode.Position(lineIdx, lineLen)
              )
            );
          }
          currentNewLine++;
        } else if (line.startsWith("-")) {
          // Removed line: not present in the new document
        } else {
          // Context line
          currentNewLine++;
        }
      }
    }

    editor.setDecorations(this.addedDecoration, addedRanges);
    return true;
  }

  /**
   * Clears added and removed decorations from the specified text editor.
   */
  clearDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(this.addedDecoration, []);
    editor.setDecorations(this.removedDecoration, []);
  }

  dispose(): void {
    this.addedDecoration.dispose();
    this.removedDecoration.dispose();
  }
}
