import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolResult } from "@aether/protocol";
import { resolveAndValidatePath } from "./security.js";
import { globFiles } from "./fs.js";

export interface CodeSymbolsInput {
  path?: string;
  pattern?: string;
  maxResults?: number;
}

export interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable";
  file: string;
  line: number;
}

/**
 * code.symbols: Scans source files and extracts top-level symbols (functions, classes, types).
 */
export async function findSymbols(
  workspaceRoot: string,
  input?: CodeSymbolsInput
): Promise<ToolResult> {
  const startTime = Date.now();
  const targetDir = resolveAndValidatePath(workspaceRoot, input?.path ?? ".");
  const maxResults = input?.maxResults ?? 200;

  try {
    const globRes = await globFiles(workspaceRoot, {
      path: path.relative(workspaceRoot, targetDir) || ".",
      pattern: input?.pattern ?? "**/*.{ts,js,tsx,jsx,py,go,rs}",
      maxResults: 100,
    });

    const files = (globRes.result as { files: string[] })?.files ?? [];
    const symbols: CodeSymbol[] = [];

    for (const relFile of files) {
      if (symbols.length >= maxResults) break;
      const fullPath = path.resolve(workspaceRoot, relFile);
      try {
        const content = await fs.readFile(fullPath, "utf-8");
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          let match: RegExpExecArray | null;
          const re = new RegExp(
            /(?:export\s+)?(?:async\s+)?(function\*?|class|interface|type|const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g
          );
          while ((match = re.exec(line)) !== null) {
            const rawKind = match[1];
            const name = match[2];
            let kind: CodeSymbol["kind"] = "variable";
            if (rawKind.startsWith("function")) kind = "function";
            else if (rawKind === "class") kind = "class";
            else if (rawKind === "interface") kind = "interface";
            else if (rawKind === "type") kind = "type";

            symbols.push({
              name,
              kind,
              file: relFile,
              line: i + 1,
            });

            if (symbols.length >= maxResults) break;
          }
          if (symbols.length >= maxResults) break;
        }
      } catch {
        // Skip unreadable files
      }
    }

    return {
      ok: true,
      result: {
        count: symbols.length,
        symbols,
      },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: {
        code: "SYMBOLS_FAILED",
        message: err?.message || String(err),
        recovery: "Check directory path and pattern, then retry.",
      },
      durationMs: Date.now() - startTime,
    };
  }
}
