import { ToolResult } from "@aether/protocol";
import {
  readFile,
  listDir,
  globFiles,
  ReadFileInput,
  ListDirInput,
  GlobInput,
} from "./fs.js";
import { grep, GrepInput } from "./search.js";
import { findSymbols, CodeSymbolsInput } from "./symbols.js";
import { toolSchemas } from "./schemas.js";

export interface SubagentSpawnInput {
  role: string;
  input: string;
  budget?: {
    maxTokens?: number;
    maxToolCalls?: number;
  };
}

export type AgentLoopRunner = (options: {
  provider: any;
  systemPrompt: string;
  initialUserPrompt: string;
  toolSchemas: any;
  tracker: any;
  toolsRegistry: any;
  model?: string;
  missionId?: string;
  signal?: AbortSignal;
}) => AsyncIterable<any>;

export interface SubagentSpawnerContext {
  workspaceRoot: string;
  provider?: any;
  model?: string;
  runner?: AgentLoopRunner;
  signal?: AbortSignal;
}

/**
 * Creates a restricted read-only tool registry for the 'scout' role.
 */
export function createScoutToolRegistry(workspaceRoot: string) {
  return {
    fs: {
      read: (input: ReadFileInput): Promise<ToolResult> =>
        readFile(workspaceRoot, input),
      list: (input?: ListDirInput): Promise<ToolResult> =>
        listDir(workspaceRoot, input),
      glob: (input?: GlobInput): Promise<ToolResult> =>
        globFiles(workspaceRoot, input),
    },
    search: {
      grep: (input: GrepInput): Promise<ToolResult> =>
        grep(workspaceRoot, input),
    },
    code: {
      symbols: (input?: CodeSymbolsInput): Promise<ToolResult> =>
        findSymbols(workspaceRoot, input),
    },
  };
}

/**
 * subagent.spawn: Executes an isolated inner agent loop for a delegated task.
 * The sub-agent runs with its own context window and budget, not inheriting the parent's transcript.
 */
export async function spawnSubagent(
  context: SubagentSpawnerContext,
  input: SubagentSpawnInput
): Promise<ToolResult> {
  const startTime = Date.now();

  try {
    if (!input || typeof input !== "object") {
      return {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Input must be an object.",
          recovery: "Provide a valid SubagentSpawnInput object.",
        },
        durationMs: Date.now() - startTime,
      };
    }

    if (!input.role || typeof input.role !== "string" || !input.role.trim()) {
      return {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "role must be a non-empty string.",
          recovery: "Provide a valid role string (e.g. 'scout', 'coder').",
        },
        durationMs: Date.now() - startTime,
      };
    }

    if (!input.input || typeof input.input !== "string" || !input.input.trim()) {
      return {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "input must be a non-empty string.",
          recovery: "Provide a valid task prompt for the sub-agent.",
        },
        durationMs: Date.now() - startTime,
      };
    }

    // Resolve runner and BudgetTracker (passed in context or dynamic import)
    let runner = context.runner;
    let TrackerClass: any;

    if (!runner) {
      try {
        const agentCore = await import("@aether/agent-core");
        runner = agentCore.runAgentLoop;
        TrackerClass = agentCore.BudgetTracker;
      } catch (err: any) {
        return {
          ok: false,
          error: {
            code: "RUNNER_UNAVAILABLE",
            message: `Could not load agent-core runner: ${err?.message || String(err)}`,
            recovery: "Ensure @aether/agent-core is available and runner is provided.",
          },
          durationMs: Date.now() - startTime,
        };
      }
    }

    // Determine tools & schemas based on role
    let subRegistry: any;
    let subSchemas: any;

    if (input.role.toLowerCase() === "scout") {
      subRegistry = createScoutToolRegistry(context.workspaceRoot);
      subSchemas = {
        "fs.read": toolSchemas["fs.read"],
        "fs.list": toolSchemas["fs.list"],
        "fs.glob": toolSchemas["fs.glob"],
        "search.grep": toolSchemas["search.grep"],
        "code.symbols": (toolSchemas as any)["code.symbols"],
      };
    } else {
      const { ToolRegistry } = await import("./index.js");
      subRegistry = new ToolRegistry(context.workspaceRoot);
      subSchemas = toolSchemas;
    }

    // Isolated budget limits
    const subBudget = {
      maxTokens: input.budget?.maxTokens ?? 100_000,
      maxToolCalls: input.budget?.maxToolCalls ?? 30,
      maxUsd: 1.0,
      maxWallClockMs: 300_000,
    };

    let tracker: any;
    if (TrackerClass) {
      tracker = new TrackerClass(subBudget);
    } else {
      tracker = {
        recordUsage: () => {},
        recordToolCall: () => {},
        assertWithinBudget: () => {},
        currentUsd: 0,
        currentTokens: 0,
        toolCallCount: 0,
      };
    }

    // Isolated system prompt
    const systemPrompt = `You are an autonomous sub-agent operating with role '${input.role}'.
Execute the goal with precision. You operate in an isolated context window with no access to previous conversation turns.
When complete, provide a clear and concise summary of your findings or results.`;

    const loop = runner({
      provider: context.provider,
      systemPrompt,
      initialUserPrompt: input.input,
      toolSchemas: subSchemas,
      tracker,
      toolsRegistry: subRegistry,
      model: context.model,
      signal: context.signal,
    });

    let finalText = "";
    for await (const event of loop) {
      if (event.type === "run.finished" && event.payload?.content) {
        finalText = event.payload.content;
      } else if (event.type === "turn.text_delta" && event.payload?.text) {
        finalText += event.payload.text;
      }
    }

    return {
      ok: true,
      result: {
        role: input.role,
        finalResult: finalText,
      },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: {
        code: "SUBAGENT_SPAWN_FAILED",
        message: err?.message || String(err),
        recovery: "Check sub-agent input and retry.",
      },
      durationMs: Date.now() - startTime,
    };
  }
}
