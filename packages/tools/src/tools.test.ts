import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveAndValidatePath } from "./security.js";
import { readFile, listDir, globFiles, patchFile } from "./fs.js";
import { grep } from "./search.js";
import { execCommand } from "./terminal.js";
import { ToolRegistry } from "./index.js";
import { toolSchemas } from "./schemas.js";

describe("Tool Layer v1", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "aether-tools-test-"));
    // Canonical realpath for tmpDir
    tmpDir = fs.realpathSync(tmpDir);
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe("Security Guard (resolveAndValidatePath)", () => {
    it("should allow valid paths within workspace root", () => {
      const sub = path.join(tmpDir, "src", "index.ts");
      fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
      fs.writeFileSync(sub, "test");

      const resolved = resolveAndValidatePath(tmpDir, "src/index.ts");
      expect(resolved).toBe(fs.realpathSync(sub));
    });

    it("should block path traversal escaping workspace root", () => {
      expect(() => {
        resolveAndValidatePath(tmpDir, "../outside.txt");
      }).toThrow(/traversal denied/i);

      expect(() => {
        resolveAndValidatePath(tmpDir, "foo/../../outside.txt");
      }).toThrow(/traversal denied/i);
    });

    it("should block absolute paths outside workspace root", () => {
      const outsidePath = path.resolve(tmpDir, "..", "other.txt");
      expect(() => {
        resolveAndValidatePath(tmpDir, outsidePath);
      }).toThrow(/traversal denied/i);
    });

    it("should block symlink escaping workspace root", () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-outside-"));
      const outsideFile = path.join(outsideDir, "secret.txt");
      fs.writeFileSync(outsideFile, "secret");

      const linkPath = path.join(tmpDir, "symlink-escape.txt");
      try {
        fs.symlinkSync(outsideFile, linkPath);
        expect(() => {
          resolveAndValidatePath(tmpDir, "symlink-escape.txt");
        }).toThrow(/escape denied/i);
      } catch (err: any) {
        // On Windows non-admin, symlinkSync may require SeCreateSymbolicLinkPrivilege
        if (err.code !== "EPERM") {
          throw err;
        }
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe("fs.read", () => {
    it("should read file content and support line slicing", async () => {
      const filePath = path.join(tmpDir, "sample.txt");
      fs.writeFileSync(filePath, "line 1\nline 2\nline 3\nline 4\nline 5");

      const res = await readFile(tmpDir, {
        path: "sample.txt",
        startLine: 2,
        endLine: 4,
      });

      expect(res.ok).toBe(true);
      expect((res.result as any).content).toBe("line 2\nline 3\nline 4");
      expect((res.result as any).startLine).toBe(2);
      expect((res.result as any).endLine).toBe(4);
    });

    it("should cap byte output when maxBytes is exceeded", async () => {
      const filePath = path.join(tmpDir, "large.txt");
      fs.writeFileSync(filePath, "0123456789".repeat(100)); // 1000 bytes

      const res = await readFile(tmpDir, {
        path: "large.txt",
        maxBytes: 50,
      });

      expect(res.ok).toBe(true);
      expect(res.truncated).toBe(true);
      expect((res.result as any).bytes).toBe(50);
      expect(res.truncationHint).toContain("50 bytes");
    });

    it("should return ok: false for non-existent files", async () => {
      const res = await readFile(tmpDir, { path: "nonexistent.txt" });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("FILE_NOT_FOUND");
      expect(res.error?.recovery).toBeDefined();
    });
  });

  describe("fs.list", () => {
    it("should list entries inside a directory", async () => {
      fs.mkdirSync(path.join(tmpDir, "subdir"));
      fs.writeFileSync(path.join(tmpDir, "file1.txt"), "hello");
      fs.writeFileSync(path.join(tmpDir, "file2.txt"), "world");

      const res = await listDir(tmpDir, { path: "." });
      expect(res.ok).toBe(true);

      const entries = (res.result as any).entries;
      expect(entries.map((e: any) => e.name)).toEqual(["subdir", "file1.txt", "file2.txt"]);
      expect(entries[0].isDirectory).toBe(true);
      expect(entries[1].isFile).toBe(true);
    });
  });

  describe("fs.glob", () => {
    it("should find files matching a glob pattern", async () => {
      fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "src", "app.ts"), "code");
      fs.writeFileSync(path.join(tmpDir, "src", "styles.css"), "css");

      const res = await globFiles(tmpDir, { pattern: "*.ts" });
      expect(res.ok).toBe(true);
      const files = (res.result as any).files;
      expect(files.some((f: string) => f.endsWith("app.ts"))).toBe(true);
      expect(files.some((f: string) => f.endsWith("styles.css"))).toBe(false);
    });
  });

  describe("fs.patch (strict atomic unified diff)", () => {
    it("should strictly apply a single hunk unified diff", async () => {
      const targetFile = path.join(tmpDir, "code.ts");
      fs.writeFileSync(
        targetFile,
        "function add(a, b) {\n  return a - b;\n}\nexport default add;\n"
      );

      const diff = `--- a/code.ts
+++ b/code.ts
@@ -1,4 +1,4 @@
 function add(a, b) {
-  return a - b;
+  return a + b;
 }
 export default add;`;

      const res = await patchFile(tmpDir, {
        path: "code.ts",
        diff,
        rationale: "Fix subtraction bug in add function",
      });

      expect(res.ok).toBe(true);
      const content = fs.readFileSync(targetFile, "utf-8");
      expect(content).toBe("function add(a, b) {\n  return a + b;\n}\nexport default add;\n");
    });

    it("should fail atomically and provide recovery string if hunk context mismatches", async () => {
      const targetFile = path.join(tmpDir, "code.ts");
      const original = "const x = 10;\nconst y = 20;\nconst z = 30;\n";
      fs.writeFileSync(targetFile, original);

      // Intentionally incorrect context
      const diff = `@@ -1,3 +1,3 @@
 const x = 999;
-const y = 20;
+const y = 200;
 const z = 30;`;

      const res = await patchFile(tmpDir, {
        path: "code.ts",
        diff,
        rationale: "Change y to 200",
      });

      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("HUNK_FAILED");
      expect(res.error?.recovery).toContain("Re-read the file around line 1");

      // Verify file is UNMODIFIED (atomic)
      expect(fs.readFileSync(targetFile, "utf-8")).toBe(original);
    });

    it("should create a new file from diff", async () => {
      const diff = `--- /dev/null
+++ b/newfile.txt
@@ -0,0 +1,2 @@
+first line
+second line`;

      const res = await patchFile(tmpDir, {
        path: "newfile.txt",
        diff,
        rationale: "Create new file",
      });

      expect(res.ok).toBe(true);
      const content = fs.readFileSync(path.join(tmpDir, "newfile.txt"), "utf-8");
      expect(content).toBe("first line\nsecond line");
    });
  });

  describe("search.grep", () => {
    it("should search for regex pattern in workspace files", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "test.txt"),
        "apple\nbanana cherry\ndate fruit\nbanana split"
      );

      const res = await grep(tmpDir, {
        query: "banana",
      });

      expect(res.ok).toBe(true);
      const matches = (res.result as any).matches;
      expect(matches.length).toBe(2);
      expect(matches[0].line).toBe(2);
      expect(matches[0].content).toContain("banana cherry");
      expect(matches[1].line).toBe(4);
      expect(matches[1].content).toContain("banana split");
    });
  });

  describe("terminal.exec", () => {
    it("should execute shell commands and capture output", async () => {
      const res = await execCommand(tmpDir, {
        command: "node -e \"console.log('terminal-ok')\"",
        rationale: "Test node execution",
      });

      expect(res.ok).toBe(true);
      expect((res.result as any).stdout.trim()).toBe("terminal-ok");
      expect((res.result as any).exitCode).toBe(0);
    });

    it("should return ok: false with error for failing commands", async () => {
      const res = await execCommand(tmpDir, {
        command: "node -e \"process.exit(42)\"",
        rationale: "Test exit code error",
      });

      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("EXEC_ERROR");
      expect((res.result as any).exitCode).toBe(42);
    });

    it("should enforce timeout on hanging commands", async () => {
      const res = await execCommand(tmpDir, {
        command: "node -e \"setTimeout(() => {}, 10000)\"",
        rationale: "Test command timeout",
        timeoutMs: 100,
      });

      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("TIMEOUT");
      expect(res.error?.recovery).toContain("timeoutMs");
    });
  });

  describe("ToolRegistry & Schemas", () => {
    it("should expose all schemas with required fields", () => {
      expect(toolSchemas["fs.patch"].required).toContain("diff");
      expect(toolSchemas["fs.patch"].required).toContain("rationale");
      expect(toolSchemas["terminal.exec"].required).toContain("command");
      expect(toolSchemas["terminal.exec"].required).toContain("rationale");
    });

    it("should instantiate ToolRegistry and call tools", async () => {
      const registry = new ToolRegistry(tmpDir);
      fs.writeFileSync(path.join(tmpDir, "hello.txt"), "world");

      const readRes = await registry.fs.read({ path: "hello.txt" });
      expect(readRes.ok).toBe(true);
      expect((readRes.result as any).content).toBe("world");
    });

    it("should execute artifact.publish and return published envelope", async () => {
      const registry = new ToolRegistry(tmpDir);
      const res = await registry.artifact.publish({
        id: "plan-1",
        type: "plan",
        title: "Test Plan",
        body: { steps: ["Step 1", "Step 2"] },
      });

      expect(res.ok).toBe(true);
      expect((res.result as any).artifact.title).toBe("Test Plan");
      expect((res.result as any).artifact.status).toBe("published");
    });

    it("should execute human.ask and return suspended turn awaiting input", async () => {
      let askedQuestion = "";
      const registry = new ToolRegistry(tmpDir, {
        onHumanAsk: (q) => {
          askedQuestion = q;
        },
      });

      const res = await registry.human.ask({
        question: "Should we proceed with database migration?",
      });

      expect(res.ok).toBe(true);
      expect((res.result as any).suspended).toBe(true);
      expect((res.result as any).question).toBe(
        "Should we proceed with database migration?"
      );
      expect(askedQuestion).toBe("Should we proceed with database migration?");
    });

    it("should expose codebase.search schema with query required", () => {
      expect(toolSchemas["codebase.search"].required).toContain("query");
    });

    it("should execute codebase.search through ToolRegistry with vectorStore", async () => {
      const mockVectorStore = {
        search: async (query: string, limit: number) => {
          return [
            {
              filepath: "src/auth/login.ts",
              content: "export async function loginUser(req) { ... }",
              startLine: 15,
              endLine: 30,
              score: 0.95,
            },
          ];
        },
      };

      const registry = new ToolRegistry(tmpDir, {
        vectorStore: mockVectorStore,
      });

      const res = await registry.codebase.search({
        query: "login authentication handler",
        maxResults: 3,
      });

      expect(res.ok).toBe(true);
      const data = res.result as any;
      expect(data.count).toBe(1);
      expect(data.matches[0].filepath).toBe("src/auth/login.ts");
      expect(data.matches[0].lines).toBe("L15-L30");
      expect(data.matches[0].score).toBe(0.95);
    });

    it("should fail codebase.search when query is missing", async () => {
      const registry = new ToolRegistry(tmpDir);
      const res = await registry.codebase.search({ query: "   " });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("invalid_input");
    });
  });
});

