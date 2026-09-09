import * as path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { GitWorktreeManager, ExecFunction } from "./worktree.js";

describe("GitWorktreeManager", () => {
  const workspaceRoot = path.resolve("/dummy/workspace");

  describe("path resolution", () => {
    it("should resolve worktree path correctly inside .aether/worktrees", () => {
      const manager = new GitWorktreeManager(workspaceRoot);
      const missionId = "m_test_12345";
      const expectedPath = path.resolve(workspaceRoot, ".aether", "worktrees", missionId);

      expect(manager.getWorktreePath(missionId)).toBe(expectedPath);
    });

    it("should handle relative workspaceRoot paths and resolve to absolute", () => {
      const relativeRoot = "./sub/project";
      const manager = new GitWorktreeManager(relativeRoot);
      const missionId = "m_rel_67890";
      const expectedPath = path.resolve(process.cwd(), relativeRoot, ".aether", "worktrees", missionId);

      expect(manager.getWorktreePath(missionId)).toBe(expectedPath);
      expect(path.isAbsolute(manager.getWorktreePath(missionId))).toBe(true);
    });

    it("should isolate paths for different mission IDs", () => {
      const manager = new GitWorktreeManager(workspaceRoot);
      const path1 = manager.getWorktreePath("mission_alpha");
      const path2 = manager.getWorktreePath("mission_beta");

      expect(path1).not.toBe(path2);
      expect(path1).toContain("mission_alpha");
      expect(path2).toContain("mission_beta");
    });
  });

  describe("create and cleanup execution", () => {
    it("should execute git worktree add with correct branch and baseRef", async () => {
      const executedCommands: Array<{ command: string; cwd?: string }> = [];
      const mockExec: ExecFunction = async (command, options) => {
        executedCommands.push({ command, cwd: options?.cwd });
        return { stdout: "", stderr: "" };
      };

      const manager = new GitWorktreeManager(workspaceRoot, { exec: mockExec });
      const missionId = "mission_001";
      const baseRef = "main";
      const targetPath = manager.getWorktreePath(missionId);

      const returnedPath = await manager.create(missionId, baseRef);

      expect(returnedPath).toBe(targetPath);
      expect(executedCommands).toHaveLength(1);
      expect(executedCommands[0].cwd).toBe(workspaceRoot);
      expect(executedCommands[0].command).toBe(
        `git worktree add "${targetPath}" -b aether/${missionId} ${baseRef}`
      );
    });

    it("should default baseRef to HEAD if not provided", async () => {
      const executedCommands: Array<{ command: string; cwd?: string }> = [];
      const mockExec: ExecFunction = async (command, options) => {
        executedCommands.push({ command, cwd: options?.cwd });
        return { stdout: "", stderr: "" };
      };

      const manager = new GitWorktreeManager(workspaceRoot, { exec: mockExec });
      const missionId = "mission_default_ref";
      const targetPath = manager.getWorktreePath(missionId);

      await manager.create(missionId);

      expect(executedCommands[0].command).toBe(
        `git worktree add "${targetPath}" -b aether/${missionId} HEAD`
      );
    });

    it("should execute git worktree remove and git branch -D during cleanup", async () => {
      const executedCommands: Array<{ command: string; cwd?: string }> = [];
      const mockExec: ExecFunction = async (command, options) => {
        executedCommands.push({ command, cwd: options?.cwd });
        return { stdout: "", stderr: "" };
      };

      const manager = new GitWorktreeManager(workspaceRoot, { exec: mockExec });
      const missionId = "mission_cleanup";
      const targetPath = manager.getWorktreePath(missionId);

      await manager.cleanup(missionId);

      expect(executedCommands).toHaveLength(2);
      expect(executedCommands[0]).toEqual({
        command: `git worktree remove --force "${targetPath}"`,
        cwd: workspaceRoot,
      });
      expect(executedCommands[1]).toEqual({
        command: `git branch -D aether/${missionId}`,
        cwd: workspaceRoot,
      });
    });
  });
});
