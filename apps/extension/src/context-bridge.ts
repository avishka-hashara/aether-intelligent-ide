import * as vscode from "vscode";

export interface DiagnosticItem {
  message: string;
  lineNumber: number;
  startColumn: number;
  endColumn: number;
  severity: "error" | "warning" | "information" | "hint" | "unknown";
  source?: string;
  code?: string | number;
}

export class ContextBridge {
  /**
   * Calls vscode.languages.getDiagnostics(document.uri) and maps the results into
   * a lightweight JSON array (message, line number, severity, etc.).
   */
  getActiveDiagnostics(document: vscode.TextDocument): DiagnosticItem[] {
    const diagnostics = vscode.languages.getDiagnostics(document.uri);

    return diagnostics.map((diag) => {
      let severity: DiagnosticItem["severity"] = "unknown";
      switch (diag.severity) {
        case vscode.DiagnosticSeverity.Error:
          severity = "error";
          break;
        case vscode.DiagnosticSeverity.Warning:
          severity = "warning";
          break;
        case vscode.DiagnosticSeverity.Information:
          severity = "information";
          break;
        case vscode.DiagnosticSeverity.Hint:
          severity = "hint";
          break;
      }

      return {
        message: diag.message,
        lineNumber: diag.range.start.line + 1,
        startColumn: diag.range.start.character + 1,
        endColumn: diag.range.end.character + 1,
        severity,
        source: diag.source,
        code: typeof diag.code === "object" ? diag.code.value : diag.code,
      };
    });
  }
}
