import { describe, it, expect, vi } from "vitest";
import { BudgetTracker, BudgetExhaustedError, Budget } from "./budget.js";
import { LoopDetector } from "./loop-detector.js";
import { runAgentLoop } from "./loop.js";
import { LLMProvider, ChatRequest } from "@aether/providers";
import { ChatStreamEvent, MissionEvent, ToolResult } from "@aether/protocol";

describe("Budget Governor", () => {
  const budget: Budget = {
    maxUsd: 0.5,
    maxTokens: 1000,
    maxWallClockMs: 5000,
    maxToolCalls: 5,
  };

  it("should not throw when within budget", () => {
    const tracker = new BudgetTracker(budget);
    tracker.recordUsage(500, 0.2);
    tracker.recordToolCall(2);
    expect(() => tracker.check()).not.toThrow();
  });

  it("should throw BudgetExhaustedError when tokens exceeded", () => {
    const tracker = new BudgetTracker(budget);
    tracker.recordUsage(1000, 0.1);
    expect(() => tracker.check()).toThrow(BudgetExhaustedError);
    try {
      tracker.check();
    } catch (err: any) {
      expect(err.reason).toBe("maxTokens");
      expect(err.current).toBe(1000);
      expect(err.limit).toBe(1000);
    }
  });

  it("should throw BudgetExhaustedError when spend exceeded", () => {
    const tracker = new BudgetTracker(budget);
    tracker.recordUsage(10, 0.55);
    expect(() => tracker.check()).toThrow(BudgetExhaustedError);
    try {
      tracker.check();
    } catch (err: any) {
      expect(err.reason).toBe("maxUsd");
    }
  });

  it("should throw BudgetExhaustedError when tool calls exceeded", () => {
    const tracker = new BudgetTracker(budget);
    tracker.recordToolCall(5);
    expect(() => tracker.check()).toThrow(BudgetExhaustedError);
    try {
      tracker.check();
    } catch (err: any) {
      expect(err.reason).toBe("maxToolCalls");
    }
  });

  it("should throw BudgetExhaustedError when wall clock time exceeded", () => {
    // Start time 10 seconds in the past
    const tracker = new BudgetTracker(budget, { startTime: Date.now() - 6000 });
    expect(() => tracker.check()).toThrow(BudgetExhaustedError);
    try {
      tracker.check();
    } catch (err: any) {
      expect(err.reason).toBe("maxWallClockMs");
    }
  });
});

describe("LoopDetector", () => {
  it("should detect repetition after 3 consecutive identical tool calls", () => {
    const detector = new LoopDetector();

    expect(detector.addAndCheck("read_file", '{"path":"foo.ts"}')).toBe(false);
    expect(detector.addAndCheck("read_file", '{"path":"foo.ts"}')).toBe(false);
    expect(detector.addAndCheck("read_file", '{"path":"foo.ts"}')).toBe(true);
  });

  it("should normalize JSON arguments whitespace", () => {
    const detector = new LoopDetector();

    expect(detector.addAndCheck("read_file", '{"path": "foo.ts"}')).toBe(false);
    expect(detector.addAndCheck("read_file", '{"path":"foo.ts"}')).toBe(false);
    expect(detector.addAndCheck("read_file", ' { "path" : "foo.ts" } ')).toBe(true);
  });

  it("should reset consecutive count if a different tool is called", () => {
    const detector = new LoopDetector();

    expect(detector.addAndCheck("read_file", '{"path":"foo.ts"}')).toBe(false);
    expect(detector.addAndCheck("read_file", '{"path":"foo.ts"}')).toBe(false);
    // Different tool
    expect(detector.addAndCheck("list_dir", '{"path":"."}')).toBe(false);
    // Back to first tool - should NOT trigger loop yet
    expect(detector.addAndCheck("read_file", '{"path":"foo.ts"}')).toBe(false);
  });
});

describe("ReAct Agent Loop (runAgentLoop)", () => {
  const dummyBudget: Budget = {
    maxUsd: 10,
    maxTokens: 50000,
    maxWallClockMs: 60000,
    maxToolCalls: 20,
  };

  it("should run plain text loop without tool calls and yield run.finished", async () => {
    const mockProvider: LLMProvider = {
      async *chat(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
        yield { type: "text_delta", text: "Hello! " };
        yield { type: "text_delta", text: "How can I help you today?" };
        yield { type: "usage", promptTokens: 10, completionTokens: 12 };
        yield { type: "done" };
      },
      async models() {
        return [];
      },
      countTokens(text: string) {
        return Math.ceil(text.length / 4);
      },
    };

    const tracker = new BudgetTracker(dummyBudget);
    const events: MissionEvent[] = [];

    const loop = runAgentLoop({
      provider: mockProvider,
      systemPrompt: "You are an assistant.",
      initialUserPrompt: "Hi",
      toolSchemas: [],
      tracker,
      toolsRegistry: {},
    });

    for await (const event of loop) {
      events.push(event);
    }

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("turn.started");
    expect(eventTypes).toContain("turn.text_delta");
    expect(eventTypes).toContain("turn.usage");
    expect(eventTypes).toContain("run.finished");

    const finishedEvent = events.find((e) => e.type === "run.finished");
    expect((finishedEvent?.payload as any).content).toBe(
      "Hello! How can I help you today?"
    );

    expect(tracker.currentTokens).toBe(22);
  });

  it("should execute tool calls, record usage and tool results, and finish", async () => {
    let turnCount = 0;

    const mockProvider: LLMProvider = {
      async *chat(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
        turnCount++;
        if (turnCount === 1) {
          // First turn: assistant calls tool
          yield {
            type: "tool_call_complete",
            id: "call_1",
            name: "fs.read",
            args: JSON.stringify({ path: "README.md" }),
          };
          yield { type: "usage", promptTokens: 20, completionTokens: 10 };
          yield { type: "done" };
        } else {
          // Second turn: assistant answers based on tool result
          yield { type: "text_delta", text: "The README says Aether IDE." };
          yield { type: "usage", promptTokens: 40, completionTokens: 8 };
          yield { type: "done" };
        }
      },
      async models() {
        return [];
      },
      countTokens(text: string) {
        return Math.ceil(text.length / 4);
      },
    };

    const mockRegistry = {
      fs: {
        read: vi.fn(async (args: any): Promise<ToolResult> => {
          return {
            ok: true,
            result: { content: "# Aether IDE" },
          };
        }),
      },
    };

    const tracker = new BudgetTracker(dummyBudget);
    const events: MissionEvent[] = [];

    const loop = runAgentLoop({
      provider: mockProvider,
      systemPrompt: "You are a coding assistant.",
      initialUserPrompt: "Read the README",
      toolSchemas: [],
      tracker,
      toolsRegistry: mockRegistry,
    });

    for await (const event of loop) {
      events.push(event);
    }

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("tool.started");
    expect(eventTypes).toContain("tool.finished");
    expect(eventTypes).toContain("run.finished");

    expect(mockRegistry.fs.read).toHaveBeenCalledWith({ path: "README.md" });
    expect(tracker.currentToolCalls).toBe(1);
    expect(tracker.currentTokens).toBe(78);
  });

  it("should detect repetition loops, inject system message, and force replan without tool execution", async () => {
    let callCount = 0;
    const toolMock = vi.fn();

    const mockProvider: LLMProvider = {
      async *chat(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
        callCount++;
        // Check if replan message was received on 4th call
        const lastMsg = req.messages[req.messages.length - 1];

        if (lastMsg?.role === "system" && lastMsg.content.includes("repeated the exact same action 3 times")) {
          // Replan response after loop warning
          yield { type: "text_delta", text: "I realized I was in a loop. I will stop." };
          yield { type: "done" };
          return;
        }

        // Model repeats identical tool call
        yield {
          type: "tool_call_complete",
          id: `call_${callCount}`,
          name: "fs.read",
          args: JSON.stringify({ path: "same.txt" }),
        };
        yield { type: "done" };
      },
      async models() {
        return [];
      },
      countTokens(text: string) {
        return Math.ceil(text.length / 4);
      },
    };

    const mockRegistry = {
      fs: {
        read: toolMock.mockResolvedValue({ ok: true, result: "content" }),
      },
    };

    const tracker = new BudgetTracker(dummyBudget);
    const events: MissionEvent[] = [];

    const loop = runAgentLoop({
      provider: mockProvider,
      systemPrompt: "Solve task",
      initialUserPrompt: "Looping task",
      toolSchemas: [],
      tracker,
      toolsRegistry: mockRegistry,
    });

    for await (const event of loop) {
      events.push(event);
    }

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("turn.loop_detected");

    // The tool should only have been executed 2 times!
    // On the 3rd time, loop was detected and tool was NOT executed!
    expect(toolMock).toHaveBeenCalledTimes(2);

    const loopEvent = events.find((e) => e.type === "turn.loop_detected");
    expect((loopEvent?.payload as any).message).toContain(
      "You have repeated the exact same action 3 times"
    );

    const finishedEvent = events.find((e) => e.type === "run.finished");
    expect((finishedEvent?.payload as any).content).toContain(
      "I realized I was in a loop. I will stop."
    );
  });

  it("should fail gracefully when budget is exhausted", async () => {
    const strictBudget: Budget = {
      maxUsd: 1,
      maxTokens: 50,
      maxWallClockMs: 60000,
      maxToolCalls: 10,
    };

    let turns = 0;
    const mockProvider: LLMProvider = {
      async *chat(): AsyncIterable<ChatStreamEvent> {
        turns++;
        yield {
          type: "tool_call_complete",
          id: "call_1",
          name: "test_tool",
          args: "{}",
        };
        // Exceed budget on first turn
        yield { type: "usage", promptTokens: 30, completionTokens: 30 };
        yield { type: "done" };
      },
      async models() {
        return [];
      },
      countTokens() {
        return 10;
      },
    };

    const tracker = new BudgetTracker(strictBudget);
    const events: MissionEvent[] = [];

    const loop = runAgentLoop({
      provider: mockProvider,
      systemPrompt: "Prompt",
      initialUserPrompt: "User input",
      toolSchemas: [],
      tracker,
      toolsRegistry: { test_tool: async () => ({ ok: true }) },
    });

    await expect(async () => {
      for await (const event of loop) {
        events.push(event);
      }
    }).rejects.toThrow(BudgetExhaustedError);

    expect(events.some((e) => e.type === "run.failed")).toBe(true);
  });
});
