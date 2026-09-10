import PQueue from "p-queue";
import { MissionEvent } from "@aether/protocol";
import { GitWorktreeManager } from "@aether/sandbox";
import { ToolRegistry, toolSchemas } from "@aether/tools";
import { LLMProvider } from "@aether/providers";
import { VectorStoreService } from "@aether/context";
import { Blackboard } from "./blackboard.js";
import { BudgetTracker, Budget } from "./budget.js";
import { runAgentLoop } from "./loop.js";

export interface MissionOrchestratorOptions {
  workspaceRoot: string;
  provider: LLMProvider;
  concurrency?: number;
  systemPrompt?: string;
  defaultModel?: string;
  defaultBudget?: Budget;
  worktreeManager?: GitWorktreeManager;
  vectorStore?: VectorStoreService | any;
  onEvent?: (event: MissionEvent) => void;
  onMissionStatusChange?: (
    missionId: string,
    status: string,
    details?: { error?: any; spendUsd?: number; tokensUsed?: number }
  ) => void;
}

export interface MissionStatusInfo {
  missionId: string;
  goal: string;
  baseRef: string;
  status: "queued" | "executing" | "completed" | "failed" | "cancelled" | "merged";
  worktreePath?: string;
  blackboard: Blackboard;
  error?: string;
}

/**
 * MissionOrchestrator manages concurrent missions using a bounded PQueue (default concurrency: 5)
 * and supports isolated worktrees and cooperative cancellation.
 */
export class MissionOrchestrator {
  readonly workspaceRoot: string;
  readonly queue: PQueue;
  private readonly worktreeManager: GitWorktreeManager;
  private readonly provider: LLMProvider;
  private readonly vectorStore?: VectorStoreService | any;
  private readonly systemPrompt: string;
  private readonly defaultModel: string;
  private readonly defaultBudget: Budget;
  private readonly onEvent?: (event: MissionEvent) => void;
  private readonly onMissionStatusChange?: (
    missionId: string,
    status: string,
    details?: { error?: any; spendUsd?: number; tokensUsed?: number }
  ) => void;

  // Active missions mapping to AbortController for cooperative cancellation
  private readonly activeMissions = new Map<string, AbortController>();
  // Mission metadata and blackboard tracking
  private readonly missions = new Map<string, MissionStatusInfo>();

  constructor(
    options: MissionOrchestratorOptions,
    vectorStore?: VectorStoreService | any
  ) {
    this.workspaceRoot = options.workspaceRoot;
    this.provider = options.provider;
    this.vectorStore = vectorStore ?? options.vectorStore;
    this.queue = new PQueue({ concurrency: options.concurrency ?? 5 });
    this.worktreeManager =
      options.worktreeManager ?? new GitWorktreeManager(options.workspaceRoot);
    this.systemPrompt =
      options.systemPrompt ??
      "You are Aether, an expert autonomous software engineer executing inside an isolated worktree.";
    this.defaultModel = options.defaultModel ?? "google/gemini-1.5-flash";
    this.defaultBudget = options.defaultBudget ?? {
      maxUsd: 2.0,
      maxTokens: 500_000,
      maxWallClockMs: 1_800_000,
      maxToolCalls: 100,
    };
    this.onEvent = options.onEvent;
    this.onMissionStatusChange = options.onMissionStatusChange;
  }

  getWorktreeManager(): GitWorktreeManager {
    return this.worktreeManager;
  }

  getMission(missionId: string): MissionStatusInfo | undefined {
    return this.missions.get(missionId);
  }

  getBlackboard(missionId: string): Blackboard | undefined {
    return this.missions.get(missionId)?.blackboard;
  }

  getActiveMissionCount(): number {
    return this.activeMissions.size;
  }

  /**
   * Dispatches a mission to the bounded PQueue.
   */
  async dispatch(
    missionId: string,
    goal: string,
    baseRef: string = "HEAD",
    customBudget?: Budget,
    customModel?: string
  ): Promise<void> {
    const abortController = new AbortController();
    this.activeMissions.set(missionId, abortController);

    const blackboard = new Blackboard({
      missionId,
      goal,
      status: "queued",
      baseRef,
    });

    const missionInfo: MissionStatusInfo = {
      missionId,
      goal,
      baseRef,
      status: "queued",
      blackboard,
    };
    this.missions.set(missionId, missionInfo);

    if (this.onMissionStatusChange) {
      this.onMissionStatusChange(missionId, "queued");
    }

    // Add worker to PQueue
    this.queue.add(async () => {
      // Verify cooperative cancellation while queued
      if (abortController.signal.aborted) {
        missionInfo.status = "cancelled";
        blackboard.set("status", "cancelled");
        if (this.onMissionStatusChange) {
          this.onMissionStatusChange(missionId, "cancelled");
        }
        this.activeMissions.delete(missionId);
        return;
      }

      missionInfo.status = "executing";
      blackboard.set("status", "executing");
      if (this.onMissionStatusChange) {
        this.onMissionStatusChange(missionId, "executing");
      }

      let worktreePath: string | undefined;
      const budget = customBudget ?? this.defaultBudget;
      const tracker = new BudgetTracker(budget);
      let finalStatus: "completed" | "failed" | "cancelled" = "completed";
      let failureError: any;

      try {
        // 1. Initialize isolated worktree
        worktreePath = await this.worktreeManager.create(missionId, baseRef);
        missionInfo.worktreePath = worktreePath;
        blackboard.set("worktreePath", worktreePath);

        const activeModel = customModel || this.defaultModel || "google/gemini-1.5-flash";

        // 2. Instantiate fresh ToolRegistry locked to the new worktree path
        const toolsRegistry = new ToolRegistry(worktreePath, {
          blackboardStore: blackboard,
          provider: this.provider,
          model: activeModel,
          agentLoopRunner: runAgentLoop,
          signal: abortController.signal,
          vectorStore: this.vectorStore,
        });

        // 3. Start the runAgentLoop
        const loop = runAgentLoop({
          provider: this.provider,
          systemPrompt: this.systemPrompt,
          initialUserPrompt: goal,
          toolSchemas,
          tracker,
          toolsRegistry,
          model: activeModel,
          missionId,
          signal: abortController.signal,
        });

        for await (const event of loop) {
          if (this.onEvent) {
            this.onEvent(event);
          }
          if (abortController.signal.aborted) {
            finalStatus = "cancelled";
            break;
          }
          if (event.type === "run.failed" || event.type === "run.aborted") {
            finalStatus = "failed";
          }
        }
      } catch (err: any) {
        failureError = err;
        finalStatus = abortController.signal.aborted ? "cancelled" : "failed";
        missionInfo.error = err?.message || String(err);
      } finally {
        this.activeMissions.delete(missionId);
        missionInfo.status = finalStatus;
        blackboard.set("status", finalStatus);
        blackboard.set("spendUsd", tracker.currentUsd);
        blackboard.set("tokensUsed", tracker.currentTokens);

        if (this.onMissionStatusChange) {
          this.onMissionStatusChange(missionId, finalStatus, {
            error: failureError,
            spendUsd: tracker.currentUsd,
            tokensUsed: tracker.currentTokens,
          });
        }
      }
    });
  }

  /**
   * Cancels an active or queued mission cooperatively.
   */
  cancel(missionId: string): boolean {
    const controller = this.activeMissions.get(missionId);
    const mission = this.missions.get(missionId);

    if (mission) {
      mission.status = "cancelled";
      mission.blackboard.set("status", "cancelled");
      if (this.onMissionStatusChange) {
        this.onMissionStatusChange(missionId, "cancelled");
      }
    }

    if (controller) {
      controller.abort();
      this.activeMissions.delete(missionId);
      return true;
    }
    return false;
  }

  /**
   * Cleans up the isolated worktree and branch for a mission.
   */
  async cleanupMission(missionId: string): Promise<void> {
    const mission = this.missions.get(missionId);
    try {
      await this.worktreeManager.cleanup(missionId);
    } catch {
      // Best effort cleanup
    }
    if (mission) {
      mission.worktreePath = undefined;
      mission.blackboard.set("worktreePath", undefined);
    }
  }
}
