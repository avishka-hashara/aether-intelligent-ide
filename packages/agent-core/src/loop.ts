import * as crypto from "node:crypto";
import { MissionEvent, ToolResult } from "@aether/protocol";
import { LLMProvider } from "@aether/providers";
import { BudgetTracker, BudgetExhaustedError } from "./budget.js";
import { LoopDetector } from "./loop-detector.js";

export interface RunAgentLoopOptions {
  provider: LLMProvider;
  systemPrompt: string;
  initialUserPrompt: string;
  toolSchemas: any;
  tracker: BudgetTracker;
  toolsRegistry: any;
  model?: string;
  missionId?: string;
  runId?: string;
  signal?: AbortSignal;
}

function formatTools(tools: any): any[] {
  if (!tools) return [];
  if (Array.isArray(tools)) {
    return tools.map((t) => {
      if (t.type === "function" && t.function) return t;
      return {
        type: "function",
        function: {
          name: t.name || "tool",
          description: t.description || "",
          parameters: t.parameters || t.schema || t,
        },
      };
    });
  }
  if (typeof tools === "object") {
    return Object.entries(tools).map(([name, schema]: [string, any]) => ({
      type: "function",
      function: {
        name,
        description: schema.description || `Execute ${name}`,
        parameters: schema,
      },
    }));
  }
  return [];
}

async function executeTool(
  registry: any,
  name: string,
  argsRaw: string | Record<string, any>
): Promise<ToolResult> {
  let args: any;
  if (typeof argsRaw === "string") {
    try {
      args = JSON.parse(argsRaw || "{}");
    } catch {
      args = argsRaw;
    }
  } else {
    args = argsRaw;
  }

  // 1. Direct function on registry (e.g. registry["get_weather"])
  if (typeof registry[name] === "function") {
    return await registry[name](args);
  }

  // 2. Dot notation, e.g. "fs.read" -> registry.fs.read(args)
  if (name.includes(".")) {
    const parts = name.split(".");
    const ns = parts[0];
    const method = parts[1];
    if (registry[ns] && typeof registry[ns][method] === "function") {
      return await registry[ns][method](args);
    }
  }

  // 3. Underscore notation, e.g. "fs_read" -> registry.fs.read(args)
  if (name.includes("_")) {
    const parts = name.split("_");
    const ns = parts[0];
    const method = parts.slice(1).join("_");
    if (registry[ns] && typeof registry[ns][method] === "function") {
      return await registry[ns][method](args);
    }
  }

  // 4. Sub-namespace lookup (fs, search, terminal)
  for (const ns of ["fs", "search", "terminal"]) {
    if (registry[ns] && typeof registry[ns][name] === "function") {
      return await registry[ns][name](args);
    }
  }

  throw new Error(`Tool '${name}' not found in tools registry.`);
}

/**
 * Executes the autonomous ReAct agent loop, yielding MissionEvents.
 */
export async function* runAgentLoop(
  providerOrOptions: LLMProvider | RunAgentLoopOptions,
  systemPrompt?: string,
  initialUserPrompt?: string,
  toolSchemas?: any,
  tracker?: BudgetTracker,
  toolsRegistry?: any,
  extraOptions?: {
    model?: string;
    missionId?: string;
    runId?: string;
    signal?: AbortSignal;
  }
): AsyncGenerator<MissionEvent, void, unknown> {
  const options: RunAgentLoopOptions =
    typeof (providerOrOptions as any).provider !== "undefined"
      ? (providerOrOptions as RunAgentLoopOptions)
      : {
          provider: providerOrOptions as LLMProvider,
          systemPrompt: systemPrompt!,
          initialUserPrompt: initialUserPrompt!,
          toolSchemas: toolSchemas!,
          tracker: tracker!,
          toolsRegistry: toolsRegistry!,
          ...extraOptions,
        };

  let seq = 1;
  const missionId = options.missionId ?? `mission-${crypto.randomUUID()}`;
  const runId = options.runId ?? `run-${crypto.randomUUID()}`;
  const model = options.model ?? "anthropic/claude-3.5-sonnet";
  const signal = options.signal;
  const loopDetector = new LoopDetector();

  const messages: any[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: options.initialUserPrompt },
  ];

  function createEvent<T>(
    type: string,
    payload: T,
    turnId?: string
  ): MissionEvent<T> {
    return {
      schemaVersion: 1,
      seq: seq++,
      id: crypto.randomUUID(),
      missionId,
      runId,
      ...(turnId ? { turnId } : {}),
      ts: new Date().toISOString(),
      type,
      payload,
    };
  }

  const formattedTools = formatTools(options.toolSchemas);

  while (true) {
    if (signal?.aborted) {
      yield createEvent("run.aborted", { reason: "AbortSignal triggered" });
      break;
    }

    // 1. Budget check before each turn
    try {
      options.tracker.check();
    } catch (err: any) {
      if (err instanceof BudgetExhaustedError) {
        yield createEvent("run.failed", {
          error: "budget_exhausted",
          reason: err.reason,
          message: err.message,
        });
        throw err;
      }
      throw err;
    }

    const turnId = `turn-${crypto.randomUUID()}`;
    yield createEvent("turn.started", { turnId, model }, turnId);

    // 2. Call provider.chat with messages and tools
    const stream = options.provider.chat(
      {
        model,
        messages: [...messages],
        tools: formattedTools.length > 0 ? formattedTools : undefined,
      },
      signal ?? new AbortController().signal
    );

    let assistantText = "";
    let assistantReasoning = "";
    const completedToolCalls: Array<{ id: string; name: string; args: string }> = [];

    for await (const event of stream) {
      if (signal?.aborted) break;

      switch (event.type) {
        case "text_delta":
          assistantText += event.text;
          yield createEvent("turn.text_delta", { text: event.text }, turnId);
          break;

        case "reasoning_delta":
          assistantReasoning += event.text;
          yield createEvent("turn.reasoning_delta", { text: event.text }, turnId);
          break;

        case "tool_call_complete":
          completedToolCalls.push({
            id: event.id,
            name: event.name,
            args: event.args,
          });
          break;

        case "usage":
          options.tracker.recordUsage(
            event.promptTokens + event.completionTokens
          );
          yield createEvent(
            "turn.usage",
            {
              promptTokens: event.promptTokens,
              completionTokens: event.completionTokens,
            },
            turnId
          );
          break;

        case "error":
          yield createEvent("turn.error", { message: event.message }, turnId);
          break;

        case "done":
          break;
      }
    }

    // 3. If plain text and stops (no tool calls), yield run.finished and break
    if (completedToolCalls.length === 0) {
      messages.push({ role: "assistant", content: assistantText });
      yield createEvent(
        "run.finished",
        {
          content: assistantText,
          reasoning: assistantReasoning,
        },
        turnId
      );
      break;
    }

    // 4. Append assistant's tool_calls to messages
    messages.push({
      role: "assistant",
      content: assistantText || null,
      tool_calls: completedToolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: tc.args,
        },
      })),
    });

    // 5. Process each tool call with LoopDetector
    let loopDetectedInTurn = false;

    for (const tc of completedToolCalls) {
      const isLoop = loopDetector.addAndCheck(tc.name, tc.args);

      if (isLoop) {
        loopDetectedInTurn = true;
        yield createEvent(
          "turn.loop_detected",
          {
            toolName: tc.name,
            args: tc.args,
            message:
              "You have repeated the exact same action 3 times. Re-evaluate your plan.",
          },
          turnId
        );

        // Inject system-role message describing repetition and force replan
        messages.push({
          role: "system",
          content:
            "You have repeated the exact same action 3 times. Re-evaluate your plan.",
        });
        // Hard-stop the turn without executing the tool
        break;
      }

      // No loop: execute tool securely via registry
      yield createEvent(
        "tool.started",
        {
          toolCallId: tc.id,
          name: tc.name,
          args: tc.args,
        },
        turnId
      );

      options.tracker.recordToolCall();

      let result: ToolResult;
      try {
        result = await executeTool(options.toolsRegistry, tc.name, tc.args);
      } catch (err: any) {
        result = {
          ok: false,
          error: {
            code: "TOOL_EXECUTION_ERROR",
            message: err instanceof Error ? err.message : String(err),
            recovery: "Verify tool name and parameter schema.",
          },
        };
      }

      yield createEvent(
        "tool.finished",
        {
          toolCallId: tc.id,
          name: tc.name,
          ok: result.ok,
          result: result.result,
          error: result.error,
          durationMs: result.durationMs,
        },
        turnId
      );

      const contentStr =
        typeof result === "string"
          ? result
          : JSON.stringify(
              result.ok
                ? { ok: true, result: result.result }
                : { ok: false, error: result.error }
            );

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: contentStr,
      });
    }

    // If loop was detected, turn was hard-stopped and system message injected.
    // The while loop repeats so the LLM receives the system message and replans.
  }
}
