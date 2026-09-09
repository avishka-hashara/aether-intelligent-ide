import {
  readFile,
  listDir,
  globFiles,
  patchFile,
  ReadFileInput,
  ListDirInput,
  GlobInput,
  PatchInput,
} from "./fs.js";
import { grep, GrepInput, GrepMatch } from "./search.js";
import { execCommand, TerminalExecInput } from "./terminal.js";
import {
  updateTask,
  setBlackboard,
  TaskUpdateInput,
  BlackboardSetInput,
  BlackboardStore,
  InMemoryBlackboard,
} from "./blackboard.js";
import { findSymbols, CodeSymbolsInput, CodeSymbol } from "./symbols.js";
import {
  spawnSubagent,
  SubagentSpawnInput,
  SubagentSpawnerContext,
  AgentLoopRunner,
  createScoutToolRegistry,
} from "./subagent.js";
import { ToolResult } from "@aether/protocol";

export * from "./security.js";
export * from "./fs.js";
export * from "./search.js";
export * from "./terminal.js";
export * from "./schemas.js";
export * from "./blackboard.js";
export * from "./symbols.js";
export * from "./subagent.js";

export interface ToolRegistryOptions {
  blackboardStore?: BlackboardStore;
  provider?: any;
  model?: string;
  agentLoopRunner?: AgentLoopRunner;
  signal?: AbortSignal;
}

/**
 * ToolRegistry encapsulates a workspaceRoot and provides bound tool instances
 * matching the canonical tool namespace: fs.read, fs.list, fs.glob, fs.patch, search.grep, terminal.exec, task.update, blackboard.set, code.symbols, subagent.spawn.
 */
export class ToolRegistry {
  private readonly blackboardStore: BlackboardStore;
  private readonly options: ToolRegistryOptions;

  constructor(
    readonly workspaceRoot: string,
    optionsOrBlackboard?: ToolRegistryOptions | BlackboardStore
  ) {
    if (
      optionsOrBlackboard &&
      ("get" in optionsOrBlackboard || "set" in optionsOrBlackboard)
    ) {
      this.blackboardStore = optionsOrBlackboard as BlackboardStore;
      this.options = { blackboardStore: this.blackboardStore };
    } else {
      this.options = (optionsOrBlackboard as ToolRegistryOptions) ?? {};
      this.blackboardStore =
        this.options.blackboardStore ?? new InMemoryBlackboard();
    }
  }

  get blackboardState(): BlackboardStore {
    return this.blackboardStore;
  }

  readonly fs = {
    read: (input: ReadFileInput): Promise<ToolResult> =>
      readFile(this.workspaceRoot, input),
    list: (input?: ListDirInput): Promise<ToolResult> =>
      listDir(this.workspaceRoot, input),
    glob: (input?: GlobInput): Promise<ToolResult> =>
      globFiles(this.workspaceRoot, input),
    patch: (input: PatchInput): Promise<ToolResult> =>
      patchFile(this.workspaceRoot, input),
  };

  readonly search = {
    grep: (input: GrepInput): Promise<ToolResult> =>
      grep(this.workspaceRoot, input),
  };

  readonly terminal = {
    exec: (input: TerminalExecInput): Promise<ToolResult> =>
      execCommand(this.workspaceRoot, input),
  };

  readonly task = {
    update: (input: TaskUpdateInput): Promise<ToolResult> =>
      updateTask(input, this.blackboardStore),
  };

  readonly blackboard = {
    set: (input: BlackboardSetInput): Promise<ToolResult> =>
      setBlackboard(input, this.blackboardStore),
    get: <T = unknown>(key: string): T | undefined =>
      this.blackboardStore.get<T>(key),
    getSnapshot: (): Record<string, unknown> =>
      this.blackboardStore.getSnapshot(),
  };

  readonly code = {
    symbols: (input?: CodeSymbolsInput): Promise<ToolResult> =>
      findSymbols(this.workspaceRoot, input),
  };

  readonly subagent = {
    spawn: (input: SubagentSpawnInput): Promise<ToolResult> =>
      spawnSubagent(
        {
          workspaceRoot: this.workspaceRoot,
          provider: this.options.provider,
          model: this.options.model,
          runner: this.options.agentLoopRunner,
          signal: this.options.signal,
        },
        input
      ),
  };
}
