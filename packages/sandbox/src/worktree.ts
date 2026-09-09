import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const defaultExecAsync = promisify(exec);

export type ExecFunction = (
  command: string,
  options?: { cwd?: string }
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

export interface GitWorktreeManagerOptions {
  exec?: ExecFunction;
}

/**
 * GitWorktreeManager manages isolated git worktrees for agent missions.
 */
export class GitWorktreeManager {
  readonly workspaceRoot: string;
  private readonly execFn: ExecFunction;

  constructor(workspaceRoot: string, options?: GitWorktreeManagerOptions) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.execFn = options?.exec ?? (defaultExecAsync as unknown as ExecFunction);
  }

  /**
   * Resolves the target absolute path to .aether/worktrees/${missionId}
   */
  getWorktreePath(missionId: string): string {
    return path.resolve(this.workspaceRoot, ".aether", "worktrees", missionId);
  }

  /**
   * Creates an isolated worktree for a mission branched off baseRef.
   */
  async create(missionId: string, baseRef: string = "HEAD"): Promise<string> {
    const targetPath = this.getWorktreePath(missionId);
    const command = `git worktree add "${targetPath}" -b aether/${missionId} ${baseRef}`;
    await this.execFn(command, { cwd: this.workspaceRoot });
    return targetPath;
  }

  /**
   * Cleans up the isolated worktree and discards the temporary branch.
   */
  async cleanup(missionId: string): Promise<void> {
    const targetPath = this.getWorktreePath(missionId);
    await this.execFn(`git worktree remove --force "${targetPath}"`, {
      cwd: this.workspaceRoot,
    });
    await this.execFn(`git branch -D aether/${missionId}`, {
      cwd: this.workspaceRoot,
    });
  }
}
