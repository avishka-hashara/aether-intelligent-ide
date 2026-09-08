import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { ToolResult } from "@aether/protocol";
import { resolveAndValidatePath } from "./security.js";

const DEFAULT_GREP_MAX_RESULTS = 100;

export interface GrepInput {
  query: string;
  path?: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
  filePattern?: string;
}

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

async function runRipgrep(
  targetDir: string,
  args: string[]
): Promise<{ stdout: string; exitCode: number | null } | null> {
  return new Promise((resolve) => {
    const rgProc = spawn("rg", args, {
      cwd: targetDir,
      stdio: ["ignore", "pipe", "ignore"],
    });

    let stdout = "";
    rgProc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });

    rgProc.on("error", () => {
      resolve(null);
    });

    rgProc.on("close", (code) => {
      resolve({ stdout, exitCode: code });
    });
  });
}

function nativeGrep(
  dir: string,
  baseDir: string,
  regex: RegExp,
  matches: GrepMatch[],
  maxResults: number,
  filePatternRegex?: RegExp
) {
  if (matches.length >= maxResults) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (matches.length >= maxResults) break;
    const full = path.join(dir, entry.name);
    const rel = path.relative(baseDir, full).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "dist"
      ) {
        continue;
      }
      nativeGrep(full, baseDir, regex, matches, maxResults, filePatternRegex);
    } else if (entry.isFile()) {
      if (filePatternRegex && !filePatternRegex.test(rel)) {
        continue;
      }

      try {
        const content = fs.readFileSync(full, "utf-8");
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= maxResults) break;
          const lineText = lines[i];
          if (regex.test(lineText)) {
            matches.push({
              file: rel,
              line: i + 1,
              content: lineText.trimEnd(),
            });
          }
        }
      } catch {
        // Skip binary or unreadable files
      }
    }
  }
}

function globToRegex(glob: string): RegExp {
  const hasSlash = glob.includes("/");
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/(?<!\.)\*/g, "[^/]*")
    .replace(/\?/g, ".");

  if (!hasSlash) {
    return new RegExp(`(^|/)${escaped}$`, "i");
  }
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * search.grep: Executes ripgrep for regex searches with capped results.
 */
export async function grep(
  workspaceRoot: string,
  input: GrepInput
): Promise<ToolResult> {
  const startTime = Date.now();
  try {
    if (!input.query) {
      return {
        ok: false,
        error: {
          code: "INVALID_QUERY",
          message: "Search query must not be empty.",
          recovery: "Provide a non-empty search query string.",
        },
        durationMs: Date.now() - startTime,
      };
    }

    const targetDir = resolveAndValidatePath(workspaceRoot, input.path ?? ".");

    if (!fs.existsSync(targetDir)) {
      return {
        ok: false,
        error: {
          code: "DIR_NOT_FOUND",
          message: `Target directory not found: '${input.path ?? "."}'`,
          recovery: "Verify the directory path.",
        },
        durationMs: Date.now() - startTime,
      };
    }

    const maxResults = input.maxResults ?? DEFAULT_GREP_MAX_RESULTS;
    const isRegex = input.isRegex ?? true;
    const caseSensitive = input.caseSensitive ?? false;

    // Try ripgrep first
    const rgArgs = [
      "--line-number",
      "--no-heading",
      "--color=never",
      "--max-count",
      String(maxResults + 1),
    ];

    if (!caseSensitive) {
      rgArgs.push("-i");
    }
    if (!isRegex) {
      rgArgs.push("-F");
    }
    if (input.filePattern) {
      rgArgs.push("--glob", input.filePattern);
    }

    rgArgs.push(input.query, ".");

    const rgResult = await runRipgrep(targetDir, rgArgs);
    let matches: GrepMatch[] = [];

    if (rgResult !== null) {
      const lines = rgResult.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      for (const line of lines) {
        // Format: <file>:<line>:<content>
        const firstColon = line.indexOf(":");
        if (firstColon === -1) continue;
        const secondColon = line.indexOf(":", firstColon + 1);
        if (secondColon === -1) continue;

        const file = line.slice(0, firstColon).replace(/\\/g, "/");
        const lineNum = parseInt(line.slice(firstColon + 1, secondColon), 10);
        const content = line.slice(secondColon + 1);

        if (!isNaN(lineNum)) {
          matches.push({ file, line: lineNum, content });
        }
      }
    } else {
      // Native fallback
      let regex: RegExp;
      try {
        const flags = caseSensitive ? "m" : "im";
        regex = isRegex
          ? new RegExp(input.query, flags)
          : new RegExp(
              input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              flags
            );
      } catch (err: any) {
        return {
          ok: false,
          error: {
            code: "INVALID_REGEX",
            message: `Invalid regular expression: ${err.message}`,
            recovery: "Correct the regular expression syntax or set isRegex: false.",
          },
          durationMs: Date.now() - startTime,
        };
      }

      const filePatternRegex = input.filePattern
        ? globToRegex(input.filePattern)
        : undefined;

      nativeGrep(
        targetDir,
        targetDir,
        regex,
        matches,
        maxResults + 1,
        filePatternRegex
      );
    }

    const truncated = matches.length > maxResults;
    const finalMatches = truncated ? matches.slice(0, maxResults) : matches;

    return {
      ok: true,
      result: {
        query: input.query,
        matches: finalMatches,
        count: finalMatches.length,
      },
      truncated,
      truncationHint: truncated
        ? `Found more than ${maxResults} matches. Result capped at ${maxResults}.`
        : undefined,
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: {
        code: "GREP_ERROR",
        message: err instanceof Error ? err.message : String(err),
        recovery: "Check search query and path parameters.",
      },
      durationMs: Date.now() - startTime,
    };
  }
}
