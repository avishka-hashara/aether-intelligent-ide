import { describe, it, expect } from "vitest";
import { Blackboard } from "./blackboard.js";

describe("Blackboard", () => {
  it("should initialize with empty state by default", () => {
    const bb = new Blackboard();
    expect(bb.getSnapshot()).toEqual({});
  });

  it("should initialize with provided state", () => {
    const bb = new Blackboard({ foo: "bar", count: 42 });
    expect(bb.get("foo")).toBe("bar");
    expect(bb.get<number>("count")).toBe(42);
    expect(bb.getSnapshot()).toEqual({ foo: "bar", count: 42 });
  });

  it("should set and retrieve values across different types", () => {
    const bb = new Blackboard();

    bb.set("status", "in_progress");
    bb.set("retries", 3);
    bb.set("metadata", { priority: "high", tags: ["core", "p0"] });
    bb.set("files", ["src/index.ts", "src/worktree.ts"]);

    expect(bb.get<string>("status")).toBe("in_progress");
    expect(bb.get<number>("retries")).toBe(3);
    expect(bb.get<{ priority: string; tags: string[] }>("metadata")).toEqual({
      priority: "high",
      tags: ["core", "p0"],
    });
    expect(bb.get<string[]>("files")).toEqual(["src/index.ts", "src/worktree.ts"]);
  });

  it("should return undefined for non-existent keys", () => {
    const bb = new Blackboard();
    expect(bb.get("non_existent")).toBeUndefined();
  });

  it("should overwrite existing keys on set", () => {
    const bb = new Blackboard({ key: "initial" });
    expect(bb.get("key")).toBe("initial");

    bb.set("key", "updated");
    expect(bb.get("key")).toBe("updated");
  });

  it("should return an isolated snapshot that does not mutate internal state", () => {
    const bb = new Blackboard({ key: "value" });
    const snapshot = bb.getSnapshot();

    snapshot["key"] = "mutated";
    snapshot["newKey"] = 123;

    expect(bb.get("key")).toBe("value");
    expect(bb.get("newKey")).toBeUndefined();
  });
});
