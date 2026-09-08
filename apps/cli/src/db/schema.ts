import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

// 1. Workspaces
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  rootPath: text("root_path").notNull().unique(),
  name: text("name"),
  vcsRemote: text("vcs_remote"),
  defaultBranch: text("default_branch"),
  createdAt: text("created_at").notNull(),
});

// 2. Missions
export const missions = sqliteTable(
  "missions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    goal: text("goal").notNull(),
    surface: text("surface").notNull(),
    executionMode: text("execution_mode").notNull(),
    status: text("status").notNull(),
    isolation: text("isolation").notNull(),
    worktreePath: text("worktree_path"),
    branch: text("branch"),
    baseRef: text("base_ref"),
    baseCommit: text("base_commit"),
    policyProfile: text("policy_profile").notNull(),
    budgetJson: text("budget_json").notNull(),
    spendUsd: real("spend_usd").notNull().default(0),
    tokensUsed: integer("tokens_used").notNull().default(0),
    blackboardJson: text("blackboard_json").notNull().default("{}"),
    checkpointJson: text("checkpoint_json"),
    idempotencyKey: text("idempotency_key").unique(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("ix_missions_ws_status").on(
      table.workspaceId,
      table.status,
      table.updatedAt
    ),
  ]
);

// 3. Agent Runs
export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  missionId: text("mission_id")
    .notNull()
    .references(() => missions.id, { onDelete: "cascade" }),
  parentRunId: text("parent_run_id"),
  role: text("role").notNull(),
  model: text("model").notNull(),
  status: text("status").notNull(),
  promptVersion: text("prompt_version").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  errorJson: text("error_json"),
});

// 4. Turns
export const turns = sqliteTable(
  "turns",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    requestJson: text("request_json").notNull(),
    responseJson: text("response_json"),
    finishReason: text("finish_reason"),
    generationId: text("generation_id"),
    latencyMs: integer("latency_ms"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_turns_run_idx").on(table.runId, table.idx),
  ]
);

// 5. Tool Calls
export const toolCalls = sqliteTable("tool_calls", {
  id: text("id").primaryKey(),
  turnId: text("turn_id")
    .notNull()
    .references(() => turns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  argsJson: text("args_json").notNull(),
  resultJson: text("result_json"),
  ok: integer("ok"),
  risk: text("risk"),
  approvalId: text("approval_id"),
  durationMs: integer("duration_ms"),
  createdAt: text("created_at").notNull(),
});

// 6. Mission Events
export const missionEvents = sqliteTable(
  "mission_events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    missionId: text("mission_id").notNull(),
    runId: text("run_id"),
    turnId: text("turn_id"),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    ts: text("ts").notNull(),
  },
  (table) => [
    index("ix_events_mission_seq").on(table.missionId, table.seq),
  ]
);

// 7. Cost Entries
export const costEntries = sqliteTable(
  "cost_entries",
  {
    id: text("id").primaryKey(),
    missionId: text("mission_id"),
    runId: text("run_id"),
    turnId: text("turn_id"),
    generationId: text("generation_id"),
    model: text("model").notNull(),
    provider: text("provider"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    cachedTokens: integer("cached_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    costUsd: real("cost_usd"),
    isByok: integer("is_byok"),
    latencyMs: integer("latency_ms"),
    finishReason: text("finish_reason"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("ix_cost_mission").on(table.missionId, table.createdAt),
  ]
);

// ---------------------------------------------------- Relations
export const workspacesRelations = relations(workspaces, ({ many }) => ({
  missions: many(missions),
}));

export const missionsRelations = relations(missions, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [missions.workspaceId],
    references: [workspaces.id],
  }),
  runs: many(agentRuns),
  events: many(missionEvents),
  costEntries: many(costEntries),
}));

export const agentRunsRelations = relations(agentRuns, ({ one, many }) => ({
  mission: one(missions, {
    fields: [agentRuns.missionId],
    references: [missions.id],
  }),
  parentRun: one(agentRuns, {
    fields: [agentRuns.parentRunId],
    references: [agentRuns.id],
    relationName: "runHierarchy",
  }),
  turns: many(turns),
}));

export const turnsRelations = relations(turns, ({ one, many }) => ({
  run: one(agentRuns, {
    fields: [turns.runId],
    references: [agentRuns.id],
  }),
  toolCalls: many(toolCalls),
}));

export const toolCallsRelations = relations(toolCalls, ({ one }) => ({
  turn: one(turns, {
    fields: [toolCalls.turnId],
    references: [turns.id],
  }),
}));

export const missionEventsRelations = relations(missionEvents, ({ one }) => ({
  mission: one(missions, {
    fields: [missionEvents.missionId],
    references: [missions.id],
  }),
}));

export const costEntriesRelations = relations(costEntries, ({ one }) => ({
  mission: one(missions, {
    fields: [costEntries.missionId],
    references: [missions.id],
  }),
}));
