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
import { ToolResult } from "@aether/protocol";

export * from "./security.js";
export * from "./fs.js";
export * from "./search.js";
export * from "./terminal.js";
export * from "./schemas.js";
export * from "./blackboard.js";

/**
 * ToolRegistry encapsulates a workspaceRoot and provides bound tool instances
 * matching the canonical tool namespace: fs.read, fs.list, fs.glob, fs.patch, search.grep, terminal.exec, task.update, blackboard.set.
 */
export class ToolRegistry {
  private readonly blackboardStore: BlackboardStore;

  constructor(
    readonly workspaceRoot: string,
    blackboardStore?: BlackboardStore
  ) {
    this.blackboardStore = blackboardStore ?? new InMemoryBlackboard();
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
}
