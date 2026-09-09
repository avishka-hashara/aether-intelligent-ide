import { describe, it, expect, vi } from "vitest";
import { MissionOrchestrator } from "./orchestrator.js";
import { LLMProvider } from "@aether/providers";
import { GitWorktreeManager } from "@aether/sandbox";

describe("MissionOrchestrator (@aether/agent-core)", () => {
  const workspaceRoot = "/dummy/workspace";

  const createMockProvider = (): LLMProvider =>
    ({
      chat: vi.fn(async function* () {
        yield { type: "text_delta", text: "Mission success" };
        yield { type: "done" };
      }),
      models: vi.fn(async () => []),
      countTokens: vi.fn(() => 10),
    } as unknown as LLMProvider);

  it("should enforce concurrency limits with PQueue", async () => {
    let runningCount = 0;
    let maxObservedConcurrency = 0;

    // Mock worktree manager with delayed execution
    const mockWorktreeManager = {
      workspaceRoot,
      create: vi.fn(async () => {
        runningCount++;
        if (runningCount > maxObservedConcurrency) {
          maxObservedConcurrency = runningCount;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        runningCount--;
        return "/dummy/worktree";
      }),
      cleanup: vi.fn(async () => {}),
      getWorktreePath: vi.fn(() => "/dummy/worktree"),
    } as unknown as GitWorktreeManager;

    const orchestrator = new MissionOrchestrator({
      workspaceRoot,
      provider: createMockProvider(),
      concurrency: 2,
      worktreeManager: mockWorktreeManager,
    });

    // Dispatch 5 missions
    const promises = [
      orchestrator.dispatch("m1", "Goal 1"),
      orchestrator.dispatch("m2", "Goal 2"),
      orchestrator.dispatch("m3", "Goal 3"),
      orchestrator.dispatch("m4", "Goal 4"),
    ];

    await Promise.all(promises);
    await orchestrator.queue.onIdle();

    expect(maxObservedConcurrency).toBeLessThanOrEqual(2);
    expect(mockWorktreeManager.create).toHaveBeenCalledTimes(4);
  });

  it("should support cooperative cancellation of active running missions", async () => {
    let capturedSignal: AbortSignal | undefined;

    const mockProvider = {
      chat: vi.fn(async function* (_options, signal) {
        capturedSignal = signal;
        // Wait until aborted
        while (!signal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }),
      models: vi.fn(async () => []),
      countTokens: vi.fn(() => 10),
    } as unknown as LLMProvider;

    const mockWorktreeManager = {
      workspaceRoot,
      create: vi.fn(async () => "/dummy/worktree/cancel"),
      cleanup: vi.fn(async () => {}),
      getWorktreePath: vi.fn(() => "/dummy/worktree/cancel"),
    } as unknown as GitWorktreeManager;

    const orchestrator = new MissionOrchestrator({
      workspaceRoot,
      provider: mockProvider,
      worktreeManager: mockWorktreeManager,
    });

    await orchestrator.dispatch("mission-cancel-test", "Cancel me");

    // Allow worker to start
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(orchestrator.getMission("mission-cancel-test")?.status).toBe("executing");

    // Cancel mission
    const cancelled = orchestrator.cancel("mission-cancel-test");
    expect(cancelled).toBe(true);

    await orchestrator.queue.onIdle();

    expect(capturedSignal?.aborted).toBe(true);
    expect(orchestrator.getMission("mission-cancel-test")?.status).toBe("cancelled");
    expect(
      orchestrator.getBlackboard("mission-cancel-test")?.get("status")
    ).toBe("cancelled");
  });

  it("should cancel queued mission before execution starts", async () => {
    const mockWorktreeManager = {
      workspaceRoot,
      create: vi.fn(async () => "/dummy/worktree"),
      cleanup: vi.fn(async () => {}),
      getWorktreePath: vi.fn(() => "/dummy/worktree"),
    } as unknown as GitWorktreeManager;

    const orchestrator = new MissionOrchestrator({
      workspaceRoot,
      provider: createMockProvider(),
      concurrency: 1,
      worktreeManager: mockWorktreeManager,
    });

    // Pause queue to keep tasks queued
    orchestrator.queue.pause();

    await orchestrator.dispatch("m_queued", "Queued mission");
    expect(orchestrator.getMission("m_queued")?.status).toBe("queued");

    // Cancel while queued
    const res = orchestrator.cancel("m_queued");
    expect(res).toBe(true);
    expect(orchestrator.getMission("m_queued")?.status).toBe("cancelled");

    // Resume queue
    orchestrator.queue.start();
    await orchestrator.queue.onIdle();

    // Worktree should not be created for cancelled queued task
    expect(mockWorktreeManager.create).not.toHaveBeenCalled();
  });

  it("should cleanup worktree on demand", async () => {
    const mockWorktreeManager = {
      workspaceRoot,
      create: vi.fn(async () => "/dummy/worktree"),
      cleanup: vi.fn(async () => {}),
      getWorktreePath: vi.fn(() => "/dummy/worktree"),
    } as unknown as GitWorktreeManager;

    const orchestrator = new MissionOrchestrator({
      workspaceRoot,
      provider: createMockProvider(),
      worktreeManager: mockWorktreeManager,
    });

    await orchestrator.dispatch("m_cleanup", "Do work");
    await orchestrator.queue.onIdle();

    await orchestrator.cleanupMission("m_cleanup");
    expect(mockWorktreeManager.cleanup).toHaveBeenCalledWith("m_cleanup");
  });
});
