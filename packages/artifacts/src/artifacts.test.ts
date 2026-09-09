import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { ArtifactStore } from "./store.js";
import { runAgentLoop, BudgetTracker } from "../../agent-core/src/index.js";
import { LLMProvider } from "../../providers/src/index.js";

const DDL = `
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  run_id TEXT,
  type TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS artifact_comments (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  artifact_version INTEGER NOT NULL,
  anchor_json TEXT,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS steering_inbox (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  source TEXT NOT NULL,
  body TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail_json TEXT,
  decision TEXT,
  decided_by TEXT,
  scope TEXT,
  comment TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
`;

describe("ArtifactStore & Steering Inbox (@aether/artifacts)", () => {
  let sqlite: Database.Database;
  let store: ArtifactStore;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(DDL);
    store = new ArtifactStore(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("publishes a new artifact with version 1", async () => {
    const artifact = await store.publish({
      id: "art-arch-1",
      missionId: "m-100",
      type: "architecture",
      title: "System Architecture",
      status: "published",
      requiresApproval: true,
      body: { components: ["gateway", "daemon", "cli"] },
    });

    expect(artifact.id).toBe("art-arch-1");
    expect(artifact.version).toBe(1);
    expect(artifact.status).toBe("published");
    expect(artifact.requiresApproval).toBe(true);
    expect(artifact.body).toEqual({ components: ["gateway", "daemon", "cli"] });

    const latest = await store.getLatestArtifact("art-arch-1");
    expect(latest).toBeDefined();
    expect(latest?.version).toBe(1);
    expect(latest?.title).toBe("System Architecture");
  });

  it("bumps version and marks previous version as superseded on subsequent publish", async () => {
    // Publish version 1
    await store.publish({
      id: "art-plan-1",
      missionId: "m-100",
      type: "plan",
      title: "Implementation Plan v1",
      status: "published",
      requiresApproval: false,
      body: { steps: ["step 1"] },
    });

    // Publish updated plan with same ID
    const v2 = await store.publish({
      id: "art-plan-1",
      missionId: "m-100",
      type: "plan",
      title: "Implementation Plan v2",
      status: "published",
      requiresApproval: false,
      body: { steps: ["step 1", "step 2"] },
    });

    expect(v2.version).toBe(2);
    expect(v2.title).toBe("Implementation Plan v2");

    const allVersions = await store.getArtifactVersions("art-plan-1");
    expect(allVersions).toHaveLength(2);

    expect(allVersions[0].version).toBe(1);
    expect(allVersions[0].status).toBe("superseded");

    expect(allVersions[1].version).toBe(2);
    expect(allVersions[1].status).toBe("published");
    expect(allVersions[1].body).toEqual({ steps: ["step 1", "step 2"] });
  });

  it("adds comment to artifact and automatically pushes to steering inbox", async () => {
    await store.publish({
      id: "art-doc-1",
      missionId: "m-200",
      type: "doc",
      title: "API Documentation",
      status: "published",
      requiresApproval: false,
      body: { markdown: "# API" },
    });

    const comment = await store.addComment({
      artifactId: "art-doc-1",
      artifactVersion: 1,
      author: "reviewer_alice",
      body: "Please document the error responses for 401 Unauthorized.",
      status: "open",
    });

    expect(comment.id).toBeDefined();
    expect(comment.author).toBe("reviewer_alice");
    expect(comment.artifactId).toBe("art-doc-1");

    // Verify steering_inbox has pending message
    const pending = await store.consumeSteeringInbox("m-200");
    expect(pending).toHaveLength(1);
    expect(pending[0].source).toBe("reviewer_alice");
    expect(pending[0].body).toBe(
      "Please document the error responses for 401 Unauthorized."
    );
    expect(pending[0].consumedAt).toBeDefined();

    // Subsequent consume returns empty because it was consumed
    const subsequent = await store.consumeSteeringInbox("m-200");
    expect(subsequent).toHaveLength(0);
  });

  it("integrates mid-run steering into runAgentLoop", async () => {
    // Prepare a mock provider that handles two turns
    let turnCount = 0;
    const receivedMessages: any[][] = [];

    const mockProvider: LLMProvider = {
      models: async () => [],
      countTokens: (text: string) => Math.ceil(text.length / 4),
      async *chat(params) {
        receivedMessages.push([...params.messages]);
        turnCount++;

        if (turnCount === 1) {
          // First turn: assistant asks or produces text
          yield { type: "text_delta", text: "Planning initial steps..." };
          yield { type: "usage", promptTokens: 10, completionTokens: 10 };
          yield { type: "done" };
        } else {
          // Second turn: should have received steering message
          yield { type: "text_delta", text: "Adjusting plan based on feedback." };
          yield { type: "usage", promptTokens: 20, completionTokens: 10 };
          yield { type: "done" };
        }
      },
    };

    const missionId = "m-steer-test";
    const tracker = new BudgetTracker({
      maxUsd: 10,
      maxTokens: 100000,
      maxWallClockMs: 100000,
      maxToolCalls: 100,
    });

    // Seed steering message directly in store
    await store.publish({
      id: "art-steer-1",
      missionId,
      type: "code",
      title: "Draft PR",
      status: "published",
      requiresApproval: false,
      body: {},
    });

    // Add comment which queues steering feedback
    await store.addComment({
      artifactId: "art-steer-1",
      artifactVersion: 1,
      author: "user_lead",
      body: "Remember to also add input sanitization.",
      missionId,
    });

    const loop = runAgentLoop({
      provider: mockProvider,
      systemPrompt: "You are an agent.",
      initialUserPrompt: "Build the feature.",
      toolSchemas: [],
      tracker,
      toolsRegistry: {},
      missionId,
      artifactStore: store,
    });

    const events: any[] = [];
    for await (const event of loop) {
      events.push(event);
      // Break after first turn completes to check steering injection
      if (event.type === "turn.usage") {
        break;
      }
    }

    // Verify steering event was emitted
    const steerEvent = events.find((e) => e.type === "mission.steered");
    expect(steerEvent).toBeDefined();
    expect(steerEvent?.payload?.body).toBe("Remember to also add input sanitization.");

    // Verify the prompt sent to provider included the steering feedback
    const firstCallMessages = receivedMessages[0];
    const steeringMessage = firstCallMessages.find(
      (m) =>
        m.role === "user" &&
        m.content.includes("[STEERING FEEDBACK]: Remember to also add input sanitization.")
    );
    expect(steeringMessage).toBeDefined();
  });
});
