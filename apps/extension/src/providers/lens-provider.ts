import * as vscode from "vscode";

export class AetherCodeLensProvider implements vscode.CodeLensProvider {
  /**
   * Provides CodeLenses for functions, methods, classes, and interfaces.
   */
  async provideCodeLenses(
    document: vscode.TextDocument,
    _token?: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    try {
      const symbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[]
      >("vscode.executeDocumentSymbolProvider", document.uri);

      if (!symbols || !Array.isArray(symbols)) {
        return [];
      }

      const lenses: vscode.CodeLens[] = [];
      this.collectLenses(document.uri, symbols, lenses);
      return lenses;
    } catch {
      return [];
    }
  }

  private collectLenses(
    uri: vscode.Uri,
    symbols: vscode.DocumentSymbol[],
    lenses: vscode.CodeLens[]
  ): void {
    for (const symbol of symbols) {
      if (
        symbol.kind === vscode.SymbolKind.Function ||
        symbol.kind === vscode.SymbolKind.Method ||
        symbol.kind === vscode.SymbolKind.Class ||
        symbol.kind === vscode.SymbolKind.Interface
      ) {
        const lens = new vscode.CodeLens(symbol.range, {
          title: "✨ Aether: Modify",
          command: "aether.lensAction",
          arguments: [uri, symbol.range, symbol.name],
        });
        lenses.push(lens);
      }

      if (symbol.children && symbol.children.length > 0) {
        this.collectLenses(uri, symbol.children, lenses);
      }
    }
  }
}
