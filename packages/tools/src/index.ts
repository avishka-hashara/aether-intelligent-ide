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
import { ToolResult } from "@aether/protocol";

export * from "./security.js";
export * from "./fs.js";
export * from "./search.js";
export * from "./terminal.js";
export * from "./schemas.js";

/**
 * ToolRegistry encapsulates a workspaceRoot and provides bound tool instances
 * matching the canonical tool namespace: fs.read, fs.list, fs.glob, fs.patch, search.grep, terminal.exec.
 */
export class ToolRegistry {
  constructor(readonly workspaceRoot: string) {}

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
}
