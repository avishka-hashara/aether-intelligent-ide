import * as path from "node:path";
import * as fs from "node:fs/promises";
import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "./index.js";
import { spawnSubagent, createScoutToolRegistry } from "./subagent.js";
import { toolSchemas } from "./schemas.js";

describe("Sub-agent Spawner & Symbols (@aether/tools)", () => {
  const workspaceRoot = path.resolve("./fixtures/subagent-test");

  describe("code.symbols", () => {
    it("should extract symbols from source files", async () => {
      const testDir = path.resolve("./fixtures/symbols-test");
      await fs.mkdir(testDir, { recursive: true });
      await fs.writeFile(
        path.join(testDir, "example.ts"),
        `export interface User { id: string; }\nexport class UserService {}\nexport function getUser() {}\nconst apiKey = "secret";`
      );

      const registry = new ToolRegistry(testDir);
      const res = await registry.code.symbols();

      expect(res.ok).toBe(true);
      const symbols = (res.result as any).symbols;
      const names = symbols.map((s: any) => s.name);
      expect(names).toContain("User");
      expect(names).toContain("UserService");
      expect(names).toContain("getUser");
      expect(names).toContain("apiKey");

      // Cleanup
      await fs.rm(testDir, { recursive: true, force: true });
    });
  });

  describe("subagent.spawn", () => {
    it("should fail gracefully when role or input is missing", async () => {
      const res1 = await spawnSubagent({ workspaceRoot }, { role: "", input: "explore" });
      expect(res1.ok).toBe(false);
      expect(res1.error?.code).toBe("INVALID_ARGUMENT");

      const res2 = await spawnSubagent({ workspaceRoot }, { role: "scout", input: "" });
      expect(res2.ok).toBe(false);
      expect(res2.error?.code).toBe("INVALID_ARGUMENT");
    });

    it("should instantiate a restricted read-only tool registry for role 'scout'", async () => {
      let capturedOptions: any;

      const mockRunner = async function* (options: any) {
        capturedOptions = options;
        yield {
          type: "run.finished",
          payload: { content: "Scouting complete: found 3 files." },
        };
      };

      const res = await spawnSubagent(
        {
          workspaceRoot,
          runner: mockRunner,
          model: "test-model",
        },
        {
          role: "scout",
          input: "Find all configuration files",
          budget: { maxTokens: 1000, maxToolCalls: 5 },
        }
      );

      expect(res.ok).toBe(true);
      expect((res.result as any).role).toBe("scout");
      expect((res.result as any).finalResult).toBe("Scouting complete: found 3 files.");

      // Check captured isolated runner options
      expect(capturedOptions).toBeDefined();
      expect(capturedOptions.initialUserPrompt).toBe("Find all configuration files");
      expect(capturedOptions.systemPrompt).toContain("role 'scout'");
      expect(capturedOptions.systemPrompt).toContain("isolated context");

      // Restricted tools for scout: only fs.read, fs.list, fs.glob, search.grep, code.symbols
      const tools = capturedOptions.toolsRegistry;
      expect(tools.fs.read).toBeDefined();
      expect(tools.fs.list).toBeDefined();
      expect(tools.fs.glob).toBeDefined();
      expect(tools.search.grep).toBeDefined();
      expect(tools.code.symbols).toBeDefined();
      expect(tools.fs.patch).toBeUndefined();
      expect(tools.terminal).toBeUndefined();

      // Restricted schemas
      expect(capturedOptions.toolSchemas["fs.read"]).toBeDefined();
      expect(capturedOptions.toolSchemas["fs.patch"]).toBeUndefined();
      expect(capturedOptions.toolSchemas["terminal.exec"]).toBeUndefined();
    });

    it("should enforce isolated budget and not inherit parent state", async () => {
      let capturedTracker: any;

      const mockRunner = async function* (options: any) {
        capturedTracker = options.tracker;
        yield {
          type: "turn.text_delta",
          payload: { text: "Analysis: " },
        };
        yield {
          type: "run.finished",
          payload: { content: "Analysis: all clear." },
        };
      };

      const registry = new ToolRegistry(workspaceRoot, {
        agentLoopRunner: mockRunner,
      });

      const res = await registry.subagent.spawn({
        role: "analyzer",
        input: "Analyze repository dependencies",
        budget: { maxTokens: 5000, maxToolCalls: 10 },
      });

      expect(res.ok).toBe(true);
      expect((res.result as any).finalResult).toBe("Analysis: all clear.");
      expect(capturedTracker).toBeDefined();
    });

    it("should be registered in toolSchemas", () => {
      expect(toolSchemas["subagent.spawn"]).toBeDefined();
      expect(toolSchemas["subagent.spawn"].required).toContain("role");
      expect(toolSchemas["subagent.spawn"].required).toContain("input");
      expect(toolSchemas["code.symbols"]).toBeDefined();
    });
  });
});
