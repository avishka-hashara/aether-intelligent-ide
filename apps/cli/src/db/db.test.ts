import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { initDB, workspaces, missions, missionEvents } from "./index.js";

describe("SQLite Persistence Layer (apps/cli/src/db)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-cli-db-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("initializes database at <workspace>/.aether/aether.db and configures WAL mode", () => {
    const { db, sqlite, dbPath } = initDB(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, ".aether"))).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);

    const journalMode = sqlite.pragma("journal_mode", { simple: true });
    expect(journalMode).toBe("wal");

    const synchronous = sqlite.pragma("synchronous", { simple: true });
    // SQLite synchronous = NORMAL corresponds to numeric value 1
    expect(synchronous).toBe(1);

    sqlite.close();
  });

  it("creates all required tables on initialization and allows mission insertion", () => {
    const { db, sqlite } = initDB(tmpDir);

    const now = new Date().toISOString();
    const wsId = path.resolve(tmpDir);

    // 1. Insert Workspace
    db.insert(workspaces)
      .values({
        id: wsId,
        rootPath: wsId,
        name: "test-workspace",
        createdAt: now,
      })
      .run();

    // 2. Insert Mission
    const missionId = "m_test123";
    db.insert(missions)
      .values({
        id: missionId,
        workspaceId: wsId,
        goal: "Test persistence goal",
        surface: "cli",
        executionMode: "autonomous",
        status: "executing",
        isolation: "inplace",
        policyProfile: "trusted",
        budgetJson: JSON.stringify({ maxUsd: 1.0, maxTokens: 1000 }),
        spendUsd: 0,
        tokensUsed: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // 3. Insert Mission Events (append-only)
    db.insert(missionEvents)
      .values({
        id: "evt_1",
        missionId,
        type: "turn.started",
        payloadJson: JSON.stringify({ turnId: "t1" }),
        ts: now,
      })
      .run();

    db.insert(missionEvents)
      .values({
        id: "evt_2",
        missionId,
        type: "tool.finished",
        payloadJson: JSON.stringify({ name: "fs.read", ok: true }),
        ts: now,
      })
      .run();

    // Verify retrieval
    const retrievedMissions = db.select().from(missions).all();
    expect(retrievedMissions.length).toBe(1);
    expect(retrievedMissions[0].id).toBe(missionId);
    expect(retrievedMissions[0].status).toBe("executing");

    const retrievedEvents = db.select().from(missionEvents).all();
    expect(retrievedEvents.length).toBe(2);
    expect(retrievedEvents[0].type).toBe("turn.started");
    expect(retrievedEvents[1].type).toBe("tool.finished");

    sqlite.close();
  });
});
