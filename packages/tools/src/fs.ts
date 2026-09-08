import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { ToolResult } from "@aether/protocol";
import { resolveAndValidatePath } from "./security.js";

const DEFAULT_READ_MAX_BYTES = 50 * 1024; // 50 KB
const DEFAULT_GLOB_MAX_RESULTS = 500;

export interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
  maxBytes?: number;
}

export interface ListDirInput {
  path?: string;
}

export interface GlobInput {
  pattern?: string;
  path?: string;
  maxResults?: number;
}

export interface PatchInput {
  path: string;
  diff: string;
  rationale: string;
}

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

/**
 * Parses unified diff string into individual hunks.
 */
function parseUnifiedDiff(diff: string): ParsedHunk[] {
  const lines = diff.split(/\r?\n/);
  const hunks: ParsedHunk[] = [];
  let currentHunk: ParsedHunk | null = null;

  for (const line of lines) {
    const hunkHeaderMatch = line.match(
      /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/
    );

    if (hunkHeaderMatch) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      currentHunk = {
        oldStart: parseInt(hunkHeaderMatch[1], 10),
        oldCount:
          hunkHeaderMatch[2] !== undefined
            ? parseInt(hunkHeaderMatch[2], 10)
            : 1,
        newStart: parseInt(hunkHeaderMatch[3], 10),
        newCount:
          hunkHeaderMatch[4] !== undefined
            ? parseInt(hunkHeaderMatch[4], 10)
            : 1,
        lines: [],
      };
      continue;
    }

    if (currentHunk) {
      // Collect diff lines inside hunk
      if (
        line.startsWith(" ") ||
        line.startsWith("-") ||
        line.startsWith("+") ||
        line.startsWith("\\")
      ) {
        currentHunk.lines.push(line);
      }
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return hunks;
}

/**
 * fs.read: Reads a file (byte-capped) with optional startLine and endLine arguments.
 */
export async function readFile(
  workspaceRoot: string,
  input: ReadFileInput
): Promise<ToolResult> {
  const startTime = Date.now();
  try {
    const targetPath = resolveAndValidatePath(workspaceRoot, input.path);

    if (!fs.existsSync(targetPath)) {
      return {
        ok: false,
        error: {
          code: "FILE_NOT_FOUND",
          message: `File not found: '${input.path}'`,
          recovery: "Use fs.list or fs.glob to check existing files.",
        },
        durationMs: Date.now() - startTime,
      };
    }

    const stat = await fs.promises.stat(targetPath);
    if (!stat.isFile()) {
      return {
        ok: false,
        error: {
          code: "NOT_A_FILE",
          message: `Target path is not a file: '${input.path}'`,
          recovery: "Provide a path to a valid file, or use fs.list for directories.",
        },
        durationMs: Date.now() - startTime,
      };
    }

    const rawContent = await fs.promises.readFile(targetPath, "utf-8");
    const allLines = rawContent.split(/\r?\n/);
    const totalLines = allLines.length;

    let selectedLines = allLines;
    let effectiveStart = 1;
    let effectiveEnd = totalLines;

    if (input.startLine !== undefined || input.endLine !== undefined) {
      effectiveStart = Math.max(1, input.startLine ?? 1);
      effectiveEnd = Math.min(totalLines, input.endLine ?? totalLines);
      selectedLines = allLines.slice(effectiveStart - 1, effectiveEnd);
    }

    let content = selectedLines.join("\n");
    let truncated = false;
    let truncationHint: string | undefined;

    const maxBytes = input.maxBytes ?? DEFAULT_READ_MAX_BYTES;
    const contentBytes = Buffer.byteLength(content, "utf-8");

    if (contentBytes > maxBytes) {
      const buffer = Buffer.from(content, "utf-8").subarray(0, maxBytes);
      content = buffer.toString("utf-8");
      truncated = true;
      truncationHint = `File content was capped at ${maxBytes} bytes. Use startLine/endLine to read specific sections.`;
    }

    return {
      ok: true,
      result: {
        path: path.relative(workspaceRoot, targetPath).replace(/\\/g, "/"),
        content,
        totalLines,
        startLine: effectiveStart,
        endLine: effectiveEnd,
        bytes: Buffer.byteLength(content, "utf-8"),
      },
      truncated,
      truncationHint,
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: {
        code: "READ_ERROR",
        message: err instanceof Error ? err.message : String(err),
        recovery: "Verify the file path and read permissions.",
      },
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * fs.list: Lists directory contents.
 */
export async function listDir(
  workspaceRoot: string,
  input?: ListDirInput
): Promise<ToolResult> {
  const startTime = Date.now();
  try {
    const targetPath = resolveAndValidatePath(workspaceRoot, input?.path ?? ".");

    if (!fs.existsSync(targetPath)) {
      return {
        ok: false,
        error: {
          code: "DIR_NOT_FOUND",
          message: `Directory not found: '${input?.path ?? "."}'`,
          recovery: "Verify the directory path.",
        },
        durationMs: Date.now() - startTime,
      };
    }

    const dirents = await fs.promises.readdir(targetPath, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.map(async (d) => {
        let size: number | undefined;
        try {
          if (d.isFile()) {
            const s = await fs.promises.stat(path.join(targetPath, d.name));
            size = s.size;
          }
        } catch {}
        return {
          name: d.name,
          isDirectory: d.isDirectory(),
          isFile: d.isFile(),
          isSymbolicLink: d.isSymbolicLink(),
          size,
        };
      })
    );

    // Sort directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return {
      ok: true,
      result: {
        path: path.relative(workspaceRoot, targetPath).replace(/\\/g, "/") || ".",
        entries,
      },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: {
        code: "LIST_ERROR",
        message: err instanceof Error ? err.message : String(err),
        recovery: "Check directory path and permissions.",
      },
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Helper to execute ripgrep --files with native recursive fallback.
 */
async function findFilesRipgrep(
  targetDir: string,
  pattern?: string
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const args = ["--files"];
    if (pattern) {
      args.push("--glob", pattern);
    }

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
      if (code === 0 || (code === 1 && stdout.length > 0)) {
        const files = stdout
          .split(/\r?\n/)
          .map((f) => f.trim())
          .filter(Boolean);
        resolve(files);
      } else {
        resolve(null);
      }
    });
  });
}

function nativeWalkDir(
  dir: string,
  baseDir: string,
  results: string[],
  maxResults: number,
  patternRegex?: RegExp
) {
  if (results.length >= maxResults) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (results.length >= maxResults) break;
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
      nativeWalkDir(full, baseDir, results, maxResults, patternRegex);
    } else if (entry.isFile()) {
      if (!patternRegex || patternRegex.test(rel)) {
        results.push(rel);
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
 * fs.glob: Uses ripgrep --files to find files quickly (with recursive fallback).
 */
export async function globFiles(
  workspaceRoot: string,
  input?: GlobInput
): Promise<ToolResult> {
  const startTime = Date.now();
  try {
    const targetDir = resolveAndValidatePath(
      workspaceRoot,
      input?.path ?? "."
    );

    if (!fs.existsSync(targetDir)) {
      return {
        ok: false,
        error: {
          code: "DIR_NOT_FOUND",
          message: `Directory not found: '${input?.path ?? "."}'`,
          recovery: "Check the path provided for glob search.",
        },
        durationMs: Date.now() - startTime,
      };
    }

    const maxResults = input?.maxResults ?? DEFAULT_GLOB_MAX_RESULTS;
    let files: string[] | null = await findFilesRipgrep(targetDir, input?.pattern);

    if (files === null) {
      // Ripgrep not available in environment; use native fallback
      const fallbackFiles: string[] = [];
      const regex = input?.pattern ? globToRegex(input.pattern) : undefined;
      nativeWalkDir(targetDir, targetDir, fallbackFiles, maxResults + 1, regex);
      files = fallbackFiles;
    }

    const truncated = files.length > maxResults;
    const resultFiles = truncated ? files.slice(0, maxResults) : files;

    return {
      ok: true,
      result: {
        path: path.relative(workspaceRoot, targetDir).replace(/\\/g, "/") || ".",
        files: resultFiles.map((f) => f.replace(/\\/g, "/")),
        count: resultFiles.length,
      },
      truncated,
      truncationHint: truncated
        ? `Result capped at ${maxResults} files. Refine pattern to filter.`
        : undefined,
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: {
        code: "GLOB_ERROR",
        message: err instanceof Error ? err.message : String(err),
        recovery: "Verify the directory path and search pattern.",
      },
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * fs.patch: Strict atomic unified diff applier.
 * Disallows fuzzy context matching. If any hunk fails, nothing is written.
 */
export async function patchFile(
  workspaceRoot: string,
  input: PatchInput
): Promise<ToolResult> {
  const startTime = Date.now();
  try {
    if (!input.diff || !input.diff.trim()) {
      return {
        ok: false,
        error: {
          code: "EMPTY_DIFF",
          message: "The provided diff is empty.",
          recovery: "Provide a valid unified diff containing at least one hunk.",
        },
        durationMs: Date.now() - startTime,
      };
    }

    const targetPath = resolveAndValidatePath(workspaceRoot, input.path);
    const hunks = parseUnifiedDiff(input.diff);

    if (hunks.length === 0) {
      return {
        ok: false,
        error: {
          code: "NO_HUNKS_FOUND",
          message: "Could not find any unified diff hunk headers (e.g. @@ -1,4 +1,5 @@).",
          recovery: "Ensure diff follows standard unified diff format with @@ line numbers.",
        },
        durationMs: Date.now() - startTime,
      };
    }

    const fileExists = fs.existsSync(targetPath);
    let originalLines: string[] = [];
    let eol = "\n";

    if (fileExists) {
      const originalContent = await fs.promises.readFile(targetPath, "utf-8");
      eol = originalContent.includes("\r\n") ? "\r\n" : "\n";
      originalLines = originalContent.split(/\r?\n/);
    } else {
      // Creating a new file
      originalLines = [];
    }

    // Sort hunks by starting line number
    hunks.sort((a, b) => a.oldStart - b.oldStart);

    // FIRST PASS: Strict verification of all hunks (NO FUZZY MATCHING)
    for (let hIdx = 0; hIdx < hunks.length; hIdx++) {
      const hunk = hunks[hIdx];
      const startIdx = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
      let currIdx = startIdx;

      for (const line of hunk.lines) {
        const prefix = line[0];
        const text = line.slice(1);

        if (prefix === " " || prefix === "-") {
          const actualLine =
            currIdx < originalLines.length ? originalLines[currIdx] : undefined;

          if (actualLine === undefined || actualLine !== text) {
            const lineNum = currIdx + 1;
            return {
              ok: false,
              error: {
                code: "HUNK_FAILED",
                message: `Hunk #${hIdx + 1} failed at line ${lineNum}. Expected '${text}', but found '${actualLine ?? "<EOF>"}'`,
                recovery: `Re-read the file around line ${lineNum} and regenerate the diff.`,
              },
              durationMs: Date.now() - startTime,
            };
          }
          currIdx++;
        }
      }
    }

    // SECOND PASS: Apply all hunks into a new buffer (Atomic all-or-nothing)
    const newLines: string[] = [];
    let originalCursor = 0;
    let linesAdded = 0;
    let linesRemoved = 0;

    for (const hunk of hunks) {
      const startIdx = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;

      // Copy unchanged lines prior to hunk
      while (originalCursor < startIdx && originalCursor < originalLines.length) {
        newLines.push(originalLines[originalCursor]);
        originalCursor++;
      }

      for (const line of hunk.lines) {
        const prefix = line[0];
        const text = line.slice(1);

        if (prefix === " ") {
          newLines.push(text);
          originalCursor++;
        } else if (prefix === "-") {
          linesRemoved++;
          originalCursor++;
        } else if (prefix === "+") {
          linesAdded++;
          newLines.push(text);
        }
      }
    }

    // Copy remaining lines after last hunk
    while (originalCursor < originalLines.length) {
      newLines.push(originalLines[originalCursor]);
      originalCursor++;
    }

    const newContent = newLines.join(eol);

    // Ensure parent directory exists
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

    // Write file atomically
    await fs.promises.writeFile(targetPath, newContent, "utf-8");

    return {
      ok: true,
      result: {
        path: path.relative(workspaceRoot, targetPath).replace(/\\/g, "/"),
        hunksApplied: hunks.length,
        linesAdded,
        linesRemoved,
        rationale: input.rationale,
      },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: {
        code: "PATCH_ERROR",
        message: err instanceof Error ? err.message : String(err),
        recovery: "Inspect the file and re-generate a valid unified diff.",
      },
      durationMs: Date.now() - startTime,
    };
  }
}
