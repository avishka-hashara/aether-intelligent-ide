import * as fs from "node:fs";
import * as path from "node:path";
import { VectorStoreService } from "./vector-db.js";
import { ScanOptions, ScanResult } from "./types.js";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".turbo",
  ".aether",
  "local",
  ".vscode",
  "coverage",
]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".dylib",
  ".so",
  ".bin",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".mp3",
  ".wav",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".pyc",
  ".pyd",
]);

export class WorkspaceScanner {
  private readonly vectorStore: VectorStoreService;
  private readonly ignoredDirs: Set<string>;
  private readonly maxFileSizeKb: number;

  constructor(
    vectorStore: VectorStoreService,
    options: ScanOptions = {}
  ) {
    this.vectorStore = vectorStore;
    this.ignoredDirs = new Set([
      ...DEFAULT_IGNORED_DIRS,
      ...(options.ignorePatterns || []),
    ]);
    this.maxFileSizeKb = options.maxFileSizeKb || 512;
  }

  /**
   * Recursively scans the workspace directory and indexes non-binary files.
   */
  async scan(workspaceRoot: string): Promise<ScanResult> {
    const result: ScanResult = {
      indexedFiles: 0,
      totalChunks: 0,
      errors: [],
    };

    if (!fs.existsSync(workspaceRoot)) {
      return result;
    }

    const filesToIndex = this.collectFiles(workspaceRoot, workspaceRoot);

    for (const file of filesToIndex) {
      try {
        const stats = await fs.promises.stat(file.absolutePath);
        if (stats.size > this.maxFileSizeKb * 1024) {
          continue;
        }

        const content = await fs.promises.readFile(file.absolutePath, "utf8");
        const chunks = await this.vectorStore.upsertFile(
          file.relativePath,
          content
        );

        result.indexedFiles++;
        result.totalChunks += chunks.length;
      } catch (err: any) {
        result.errors?.push({
          filepath: file.relativePath,
          error: err?.message || String(err),
        });
      }
    }

    return result;
  }

  private collectFiles(
    currentDir: string,
    workspaceRoot: string
  ): Array<{ absolutePath: string; relativePath: string }> {
    const results: Array<{ absolutePath: string; relativePath: string }> = [];

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      const name = entry.name;
      const fullPath = path.join(currentDir, name);

      if (entry.isDirectory()) {
        if (this.ignoredDirs.has(name) || name.startsWith(".")) {
          continue;
        }
        results.push(...this.collectFiles(fullPath, workspaceRoot));
      } else if (entry.isFile()) {
        if (this.shouldIgnoreFile(name)) {
          continue;
        }

        const relativePath = path
          .relative(workspaceRoot, fullPath)
          .replace(/\\/g, "/");

        results.push({
          absolutePath: fullPath,
          relativePath,
        });
      }
    }

    return results;
  }

  private shouldIgnoreFile(filename: string): boolean {
    // Ignore .env variants
    if (filename.startsWith(".env") || filename === ".env") {
      return true;
    }

    // Ignore package lockfiles to avoid indexing massive dependency lists
    if (
      filename === "pnpm-lock.yaml" ||
      filename === "package-lock.json" ||
      filename === "yarn.lock"
    ) {
      return true;
    }

    // Ignore binary extensions
    const ext = path.extname(filename).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      return true;
    }

    return false;
  }
}
