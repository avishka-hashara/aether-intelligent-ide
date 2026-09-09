import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { chunkFileContent } from "./chunker.js";
import { VectorStoreService } from "./vector-db.js";
import { WorkspaceScanner } from "./scanner.js";

describe("Codebase Indexing & Semantic Vector Search (@aether/context)", () => {
  describe("chunkFileContent", () => {
    it("should return empty array for empty or whitespace content", () => {
      expect(chunkFileContent("test.ts", "")).toEqual([]);
      expect(chunkFileContent("test.ts", "   \n  \t  ")).toEqual([]);
    });

    it("should create a single chunk for content within chunkSize", () => {
      const code = "const a = 1;\nconst b = 2;\nconst c = 3;";
      const chunks = chunkFileContent("src/math.ts", code, { chunkSize: 10 });

      expect(chunks.length).toBe(1);
      expect(chunks[0].filepath).toBe("src/math.ts");
      expect(chunks[0].startLine).toBe(1);
      expect(chunks[0].endLine).toBe(3);
      expect(chunks[0].content).toBe(code);
      expect(chunks[0].id).toContain("L1-L3");
    });

    it("should create multiple overlapping chunks for long files", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
      const code = lines.join("\n");

      const chunks = chunkFileContent("src/large.ts", code, {
        chunkSize: 40,
        overlap: 5,
      });

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].startLine).toBe(1);
      expect(chunks[0].endLine).toBe(40);
      expect(chunks[1].startLine).toBe(36); // 1 + (40 - 5) = 36
      expect(chunks[chunks.length - 1].endLine).toBe(100);
    });
  });

  describe("VectorStoreService with Mock Collection", () => {
    let mockData: {
      ids: string[];
      documents: string[];
      metadatas: any[];
    };
    let mockCollection: any;
    let vectorStore: VectorStoreService;

    beforeEach(() => {
      mockData = {
        ids: [],
        documents: [],
        metadatas: [],
      };

      mockCollection = {
        upsert: vi.fn(async (params: any) => {
          mockData.ids.push(...params.ids);
          mockData.documents.push(...params.documents);
          mockData.metadatas.push(...params.metadatas);
        }),
        query: vi.fn(async (params: any) => {
          const query = params.queryTexts[0].toLowerCase();
          const matches: number[] = [];

          for (let i = 0; i < mockData.documents.length; i++) {
            if (mockData.documents[i].toLowerCase().includes(query)) {
              matches.push(i);
            }
          }

          return {
            ids: [matches.map((i) => mockData.ids[i])],
            documents: [matches.map((i) => mockData.documents[i])],
            metadatas: [matches.map((i) => mockData.metadatas[i])],
            distances: [matches.map(() => 0.15)],
          };
        }),
      };

      vectorStore = new VectorStoreService({
        collection: mockCollection,
        collectionName: "test-collection",
      });
    });

    it("should chunk file and upsert into collection", async () => {
      const code = "function add(a, b) { return a + b; }\nexport default add;";
      const chunks = await vectorStore.upsertFile("src/calc.ts", code);

      expect(chunks.length).toBe(1);
      expect(mockCollection.upsert).toHaveBeenCalledTimes(1);
      expect(mockData.ids.length).toBe(1);
      expect(mockData.metadatas[0].filepath).toBe("src/calc.ts");
      expect(mockData.metadatas[0].startLine).toBe(1);
    });

    it("should query collection and return formatted SearchResult items", async () => {
      await vectorStore.upsertFile(
        "src/auth.ts",
        "export function login(user, pass) { return verify(user, pass); }"
      );
      await vectorStore.upsertFile(
        "src/db.ts",
        "export function connectDatabase() { return openDB(); }"
      );

      const results = await vectorStore.search("login", 5);

      expect(results.length).toBe(1);
      expect(results[0].filepath).toBe("src/auth.ts");
      expect(results[0].content).toContain("verify(user, pass)");
      expect(results[0].score).toBeCloseTo(1 / 1.15, 2);
    });

    it("should return empty array for empty search queries", async () => {
      const results = await vectorStore.search("   ");
      expect(results).toEqual([]);
      expect(mockCollection.query).not.toHaveBeenCalled();
    });
  });

  describe("WorkspaceScanner", () => {
    let tmpDir: string;
    let mockVectorStore: any;
    let scanner: WorkspaceScanner;
    const indexedEntries: Array<{ filepath: string; content: string }> = [];

    beforeEach(async () => {
      tmpDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "aether-scanner-test-")
      );
      indexedEntries.length = 0;

      mockVectorStore = {
        upsertFile: vi.fn(async (filepath: string, content: string) => {
          indexedEntries.push({ filepath, content });
          return [{ id: `${filepath}#L1-L1`, filepath, content, startLine: 1, endLine: 1 }];
        }),
      };

      scanner = new WorkspaceScanner(mockVectorStore);
    });

    afterEach(async () => {
      try {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      } catch {}
    });

    it("should recursively index workspace files while ignoring .git, node_modules, and binaries", async () => {
      // 1. Valid source files
      fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "src", "index.ts"),
        "console.log('index');"
      );
      fs.writeFileSync(
        path.join(tmpDir, "src", "utils.js"),
        "export const x = 1;"
      );

      // 2. Ignored directories
      fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, ".git", "config"), "git-config");

      fs.mkdirSync(path.join(tmpDir, "node_modules", "pkg"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "node_modules", "pkg", "index.js"),
        "library-code"
      );

      fs.mkdirSync(path.join(tmpDir, "dist"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "dist", "bundle.js"), "bundled-code");

      // 3. Ignored files (.env and binary)
      fs.writeFileSync(path.join(tmpDir, ".env"), "SECRET=123");
      fs.writeFileSync(path.join(tmpDir, ".env.local"), "SECRET=456");
      fs.writeFileSync(path.join(tmpDir, "logo.png"), Buffer.from([0x89, 0x50]));
      fs.writeFileSync(path.join(tmpDir, "app.exe"), Buffer.from([0x4d, 0x5a]));
      fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "lockfile-data");

      const scanResult = await scanner.scan(tmpDir);

      expect(scanResult.indexedFiles).toBe(2);
      expect(scanResult.totalChunks).toBe(2);

      const paths = indexedEntries.map((e) => e.filepath.replace(/\\/g, "/"));
      expect(paths).toContain("src/index.ts");
      expect(paths).toContain("src/utils.js");
      expect(paths).not.toContain(".git/config");
      expect(paths).not.toContain("node_modules/pkg/index.js");
      expect(paths).not.toContain("dist/bundle.js");
      expect(paths).not.toContain(".env");
      expect(paths).not.toContain("logo.png");
    });
  });
});
