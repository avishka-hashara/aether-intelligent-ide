import * as path from "node:path";
import * as fs from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const DDL_INIT = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  name TEXT,
  vcs_remote TEXT,
  default_branch TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  surface TEXT NOT NULL,
  execution_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  isolation TEXT NOT NULL,
  worktree_path TEXT,
  branch TEXT,
  base_ref TEXT,
  base_commit TEXT,
  policy_profile TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  spend_usd REAL NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  blackboard_json TEXT NOT NULL DEFAULT '{}',
  checkpoint_json TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_missions_ws_status ON missions(workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  parent_run_id TEXT REFERENCES agent_runs(id),
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_json TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT,
  finish_reason TEXT,
  generation_id TEXT,
  latency_ms INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, idx)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  result_json TEXT,
  ok INTEGER,
  risk TEXT,
  approval_id TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mission_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  mission_id TEXT NOT NULL,
  run_id TEXT,
  turn_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_mission_seq ON mission_events(mission_id, seq);

CREATE TABLE IF NOT EXISTS cost_entries (
  id TEXT PRIMARY KEY,
  mission_id TEXT,
  run_id TEXT,
  turn_id TEXT,
  generation_id TEXT,
  model TEXT NOT NULL,
  provider TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cached_tokens INTEGER,
  reasoning_tokens INTEGER,
  cost_usd REAL,
  is_byok INTEGER,
  latency_ms INTEGER,
  finish_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cost_mission ON cost_entries(mission_id, created_at);
`;

export interface InitDBResult {
  db: ReturnType<typeof drizzle<typeof schema>>;
  sqlite: Database.Database;
  dbPath: string;
}

/**
 * Initializes better-sqlite3 database and Drizzle ORM at <workspacePath>/.aether/aether.db.
 * Creates directory and tables if they do not exist.
 */
export function initDB(workspacePath: string): InitDBResult {
  const resolvedWorkspace = path.resolve(workspacePath);
  const aetherDir = path.join(resolvedWorkspace, ".aether");

  if (!fs.existsSync(aetherDir)) {
    fs.mkdirSync(aetherDir, { recursive: true });
  }

  const dbPath = path.join(aetherDir, "aether.db");
  const sqlite = new Database(dbPath);

  // Configure SQLite WAL mode and synchronous settings
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");

  // Execute schema sync
  sqlite.exec(DDL_INIT);

  const db = drizzle(sqlite, { schema });

  return { db, sqlite, dbPath };
}

export * from "./schema.js";
