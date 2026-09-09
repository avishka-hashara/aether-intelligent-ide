import { describe, it, expect } from "vitest";
import { ToolRegistry } from "./index.js";
import {
  updateTask,
  setBlackboard,
  InMemoryBlackboard,
} from "./blackboard.js";
import { toolSchemas } from "./schemas.js";

describe("Blackboard Tools (@aether/tools)", () => {
  describe("task.update", () => {
    it("should create a new task record in the store", async () => {
      const store = new InMemoryBlackboard();
      const res = await updateTask(
        {
          taskId: "task-1",
          title: "Setup CI pipeline",
          status: "in_progress",
          filesTouched: [".github/workflows/ci.yml"],
        },
        store
      );

      expect(res.ok).toBe(true);
      expect((res.result as any).taskId).toBe("task-1");
      expect((res.result as any).task.title).toBe("Setup CI pipeline");
      expect((res.result as any).task.status).toBe("in_progress");
      expect((res.result as any).task.filesTouched).toEqual([
        ".github/workflows/ci.yml",
      ]);
      expect((res.result as any).task.updatedAt).toBeDefined();

      const allTasks = store.get<Record<string, any>>("tasks");
      expect(allTasks).toBeDefined();
      expect(allTasks!["task-1"].title).toBe("Setup CI pipeline");
    });

    it("should partially update an existing task while preserving other fields", async () => {
      const store = new InMemoryBlackboard();
      await updateTask(
        {
          taskId: "task-2",
          title: "Initial Title",
          status: "pending",
          filesTouched: ["src/a.ts"],
        },
        store
      );

      const updateRes = await updateTask(
        {
          taskId: "task-2",
          status: "completed",
        },
        store
      );

      expect(updateRes.ok).toBe(true);
      const updated = (updateRes.result as any).task;
      expect(updated.taskId).toBe("task-2");
      expect(updated.title).toBe("Initial Title");
      expect(updated.status).toBe("completed");
      expect(updated.filesTouched).toEqual(["src/a.ts"]);
    });

    it("should fail gracefully when taskId is missing or empty", async () => {
      const store = new InMemoryBlackboard();
      const res1 = await updateTask({ taskId: "" }, store);
      expect(res1.ok).toBe(false);
      expect(res1.error?.code).toBe("INVALID_ARGUMENT");

      const res2 = await updateTask({} as any, store);
      expect(res2.ok).toBe(false);
      expect(res2.error?.code).toBe("INVALID_ARGUMENT");
    });
  });

  describe("blackboard.set", () => {
    it("should set arbitrary key-value pairs into the blackboard store", async () => {
      const store = new InMemoryBlackboard();
      const res = await setBlackboard(
        { key: "build_output", value: { success: true, exitCode: 0 } },
        store
      );

      expect(res.ok).toBe(true);
      expect(res.result).toEqual({
        key: "build_output",
        value: { success: true, exitCode: 0 },
      });
      expect(store.get("build_output")).toEqual({
        success: true,
        exitCode: 0,
      });
    });

    it("should fail gracefully when key is missing or invalid", async () => {
      const store = new InMemoryBlackboard();
      const res = await setBlackboard({ key: "", value: "test" }, store);

      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("INVALID_ARGUMENT");
    });
  });

  describe("ToolRegistry integration", () => {
    it("should expose task.update and blackboard.set through the registry", async () => {
      const registry = new ToolRegistry("/dummy/workspace");

      const bbRes = await registry.blackboard.set({
        key: "mission_phase",
        value: "phase_3",
      });
      expect(bbRes.ok).toBe(true);
      expect(registry.blackboard.get("mission_phase")).toBe("phase_3");

      const taskRes = await registry.task.update({
        taskId: "task-reg-1",
        title: "Test through registry",
        status: "in_progress",
      });
      expect(taskRes.ok).toBe(true);
      expect((taskRes.result as any).task.title).toBe("Test through registry");

      const snapshot = registry.blackboard.getSnapshot();
      expect(snapshot["mission_phase"]).toBe("phase_3");
      expect((snapshot["tasks"] as any)["task-reg-1"]).toBeDefined();
    });

    it("should support injection of custom blackboard store", async () => {
      const customStore = new InMemoryBlackboard();
      customStore.set("preset_key", 123);

      const registry = new ToolRegistry("/dummy/workspace", customStore);
      expect(registry.blackboard.get<number>("preset_key")).toBe(123);

      await registry.blackboard.set({ key: "new_key", value: "hello" });
      expect(customStore.get("new_key")).toBe("hello");
    });
  });

  describe("JSON Schemas", () => {
    it("should have valid schemas registered in toolSchemas", () => {
      expect(toolSchemas["task.update"]).toBeDefined();
      expect(toolSchemas["blackboard.set"]).toBeDefined();
      expect(toolSchemas["task.update"].required).toContain("taskId");
      expect(toolSchemas["blackboard.set"].required).toContain("key");
      expect(toolSchemas["blackboard.set"].required).toContain("value");
    });
  });
});
