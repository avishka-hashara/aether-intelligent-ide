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
  publishArtifact,
  humanAsk,
  ArtifactPublishInput,
  HumanAskInput,
  ArtifactToolContext,
} from "./artifacts.js";
import {
  spawnSubagent,
  SubagentSpawnInput,
  AgentLoopRunner,
  SubagentSpawnerContext,
} from "./subagent.js";
import {
  searchCodebase,
  CodebaseSearchInput,
  CodebaseToolContext,
} from "./codebase.js";
import { ToolResult } from "@aether/protocol";

export * from "./security.js";
export * from "./fs.js";
export * from "./search.js";
export * from "./terminal.js";
export * from "./schemas.js";
export * from "./blackboard.js";
export * from "./symbols.js";
export * from "./subagent.js";
export * from "./artifacts.js";
export * from "./codebase.js";

export interface ToolRegistryOptions {
  blackboardStore?: BlackboardStore;
  provider?: any;
  model?: string;
  agentLoopRunner?: AgentLoopRunner;
  signal?: AbortSignal;
  artifactStore?: any;
  missionId?: string;
  onHumanAsk?: (question: string) => Promise<string> | void;
  vectorStore?: any;
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

  readonly artifact = {
    publish: (input: ArtifactPublishInput): Promise<ToolResult> =>
      publishArtifact(input, {
        artifactStore: this.options.artifactStore,
        missionId: this.options.missionId,
      }),
  };

  readonly human = {
    ask: (input: HumanAskInput): Promise<ToolResult> =>
      humanAsk(input, {
        artifactStore: this.options.artifactStore,
        missionId: this.options.missionId,
        onHumanAsk: this.options.onHumanAsk,
      }),
  };

  readonly codebase = {
    search: (input: CodebaseSearchInput): Promise<ToolResult> =>
      searchCodebase(input, {
        vectorStore: this.options.vectorStore,
        workspaceRoot: this.workspaceRoot,
      }),
  };
}
