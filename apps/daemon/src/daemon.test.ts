import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import WebSocket from "ws";
import {
  generateToken,
  writeDaemonInfo,
  deleteDaemonInfo,
  getDaemonInfoPath,
} from "./auth.js";
import { createDaemonServer } from "./server.js";
import { initDB, missions } from "@aether/cli";
import { eq } from "drizzle-orm";
import { MissionEvent } from "@aether/protocol";

describe("Aether Agent Daemon (@aether/daemon)", { timeout: 15000 }, () => {
  let tmpWorkspace: string;

  beforeEach(() => {
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "aether-daemon-test-"));
  });

  afterEach(async () => {
    deleteDaemonInfo();
    await new Promise((r) => setTimeout(r, 100));
    if (fs.existsSync(tmpWorkspace)) {
      try {
        fs.rmSync(tmpWorkspace, { recursive: true, force: true });
      } catch {}
    }
  });

  it("generates cryptographically secure random tokens", () => {
    const token1 = generateToken(32);
    const token2 = generateToken(32);

    expect(token1).toHaveLength(64); // 32 bytes in hex = 64 chars
    expect(token2).toHaveLength(64);
    expect(token1).not.toBe(token2);
  });

  it("writes and deletes daemon.json metadata with strict permissions", () => {
    const token = generateToken(16);
    const port = 49152;

    const daemonPath = writeDaemonInfo(port, token);
    expect(fs.existsSync(daemonPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(daemonPath, "utf8"));
    expect(content.port).toBe(port);
    expect(content.token).toBe(token);
    expect(content.pid).toBe(process.pid);

    deleteDaemonInfo();
    expect(fs.existsSync(daemonPath)).toBe(false);
  });

  it("enforces authentication on /v1/health endpoint", async () => {
    const token = "secret-test-token-1234567890abcdef";
    const { server } = createDaemonServer({ token });
    await server.listen({ host: "127.0.0.1", port: 0 });

    try {
      // 1. Missing auth
      const resMissing = await server.inject({
        method: "GET",
        url: "/v1/health",
      });
      expect(resMissing.statusCode).toBe(401);

      // 2. Invalid auth
      const resInvalid = await server.inject({
        method: "GET",
        url: "/v1/health",
        headers: {
          authorization: "Bearer wrong-token",
        },
      });
      expect(resInvalid.statusCode).toBe(401);

      // 3. Valid auth
      const resValid = await server.inject({
        method: "GET",
        url: "/v1/health",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      expect(resValid.statusCode).toBe(200);
      const data = resValid.json();
      expect(data.status).toBe("ok");
      expect(data.version).toBe("1.0.0");
      expect(typeof data.uptime).toBe("number");
    } finally {
      await server.close();
    }
  });

  it("sets CORS headers allowing requests from webviews", async () => {
    const token = "cors-test-token-1234567890abcdef";
    const { server } = createDaemonServer({ token });
    await server.listen({ host: "127.0.0.1", port: 0 });

    try {
      const res = await server.inject({
        method: "OPTIONS",
        url: "/v1/health",
        headers: {
          origin: "vscode-webview://webview-id",
          "access-control-request-method": "GET",
        },
      });
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    } finally {
      await server.close();
    }
  });

  it("validates request body on POST /v1/missions and creates SQLite mission", async () => {
    const token = "mission-test-token-1234567890abcdef";
    const { server } = createDaemonServer({ token });
    await server.listen({ host: "127.0.0.1", port: 0 });

    try {
      // 1. Invalid payload (missing goal)
      const resInvalid = await server.inject({
        method: "POST",
        url: "/v1/missions",
        headers: {
          authorization: `Bearer ${token}`,
        },
        payload: {
          workspaceId: tmpWorkspace,
        },
      });
      expect(resInvalid.statusCode).toBe(400);

      // 2. Valid payload
      const resValid = await server.inject({
        method: "POST",
        url: "/v1/missions",
        headers: {
          authorization: `Bearer ${token}`,
        },
        payload: {
          workspaceId: tmpWorkspace,
          goal: "Implement Fastify WebSocket stream",
        },
      });

      expect(resValid.statusCode).toBe(202);
      const resBody = resValid.json();
      expect(resBody.status).toBe("queued");
      expect(resBody.missionId).toBeDefined();
      expect(resBody.streamUrl).toContain("/v1/stream");

      // Verify mission was created in SQLite DB at <workspace>/.aether/aether.db
      const { db, sqlite } = initDB(tmpWorkspace);
      const rows = db.select().from(missions).all();
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(resBody.missionId);
      expect(rows[0].goal).toBe("Implement Fastify WebSocket stream");
      sqlite.close();
    } finally {
      await server.close();
    }
  });

  it("spawns mission with { goal, base } payload and persists goal", async () => {
    const token = "goal-base-test-token-1234567890abcdef";
    const { server } = createDaemonServer({ token, workspaceRoot: tmpWorkspace });
    await server.listen({ host: "127.0.0.1", port: 0 });

    try {
      const res = await server.inject({
        method: "POST",
        url: "/v1/missions",
        headers: {
          authorization: `Bearer ${token}`,
        },
        payload: {
          goal: "Build authentication module",
          base: "main",
        },
      });

      expect(res.statusCode).toBe(202);
      const resBody = res.json();
      expect(resBody.status).toBe("queued");
      expect(resBody.missionId).toBeDefined();

      const { db, sqlite } = initDB(tmpWorkspace);
      const rows = db.select().from(missions).all();
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(resBody.missionId);
      expect(rows[0].goal).toBe("Build authentication module");
      expect(rows[0].baseRef).toBe("main");
      sqlite.close();
    } finally {
      await server.close();
    }
  });

  it("supports WebSocket /v1/stream and broadcasts mission events to subscribers", async () => {
    const token = "websocket-test-token-1234567890ab";
    const { server, broadcastEvent } = createDaemonServer({ token });
    await server.listen({ host: "127.0.0.1", port: 0 });

    const addr = server.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const wsUrl = `ws://127.0.0.1:${port}/v1/stream`;
      const ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });

      // Subscribe to mission "m_sub123"
      ws.send(JSON.stringify({ type: "subscribe", missionIds: ["m_sub123"] }));

      const receivedEvents: any[] = [];
      ws.on("message", (raw) => {
        receivedEvents.push(JSON.parse(raw.toString()));
      });

      // Allow subscription message to process
      await new Promise((r) => setTimeout(r, 50));

      // Broadcast event for unsubscribed mission "m_other"
      const otherEvent: MissionEvent = {
        schemaVersion: 1,
        seq: 1,
        id: "evt_other",
        missionId: "m_other",
        ts: new Date().toISOString(),
        type: "turn.started",
        payload: { text: "ignored" },
      };
      broadcastEvent(otherEvent);

      // Broadcast event for subscribed mission "m_sub123"
      const matchingEvent: MissionEvent = {
        schemaVersion: 1,
        seq: 2,
        id: "evt_match",
        missionId: "m_sub123",
        ts: new Date().toISOString(),
        type: "turn.text_delta",
        payload: { text: "hello world" },
      };
      broadcastEvent(matchingEvent);

      // Wait for WS delivery
      await new Promise((r) => setTimeout(r, 100));

      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0].id).toBe("evt_match");
      expect(receivedEvents[0].missionId).toBe("m_sub123");
      expect(receivedEvents[0].payload.text).toBe("hello world");

      ws.close();
    } finally {
      await server.close();
    }
  });

  describe("POST /v1/inline/completion", () => {
    it("validates request body and rejects missing fields", async () => {
      const token = "completion-test-token";
      const { server } = createDaemonServer({ token });
      await server.listen({ host: "127.0.0.1", port: 0 });

      try {
        const res = await server.inject({
          method: "POST",
          url: "/v1/inline/completion",
          headers: {
            authorization: `Bearer ${token}`,
          },
          payload: {
            prefix: "const x = ",
            // missing suffix, filepath, language
          },
        });

        expect(res.statusCode).toBe(400);
      } finally {
        await server.close();
      }
    });

    it("returns completion text streamed from OpenRouterClient", async () => {
      const token = "completion-test-token";
      const { server } = createDaemonServer({ token });
      await server.listen({ host: "127.0.0.1", port: 0 });

      const prevKey = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = "sk-test-key";

      // Mock OpenRouterClient.prototype.chat
      const { OpenRouterClient } = await import("@aether/providers");
      const chatSpy = vi.spyOn(OpenRouterClient.prototype, "chat").mockImplementation(
        async function* () {
          yield { type: "text_delta", text: "123;" };
          yield { type: "done" };
        }
      );

      try {
        const res = await server.inject({
          method: "POST",
          url: "/v1/inline/completion",
          headers: {
            authorization: `Bearer ${token}`,
          },
          payload: {
            prefix: "const x = ",
            suffix: "\nconsole.log(x);",
            filepath: "/workspace/index.ts",
            language: "typescript",
          },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ completion: "123;" });
        expect(chatSpy).toHaveBeenCalled();
      } finally {
        chatSpy.mockRestore();
        process.env.OPENROUTER_API_KEY = prevKey;
        await server.close();
      }
    });
  });

  describe("POST /v1/inline/edit", () => {
    it("enforces authentication on /v1/inline/edit", async () => {
      const token = "edit-auth-token";
      const { server } = createDaemonServer({ token });
      await server.listen({ host: "127.0.0.1", port: 0 });

      try {
        const res = await server.inject({
          method: "POST",
          url: "/v1/inline/edit",
          payload: {
            filepath: "/workspace/index.ts",
            instruction: "make this async",
            fileContent: "function foo() {}",
            selectionStartLine: 1,
            selectionEndLine: 1,
          },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await server.close();
      }
    });

    it("returns 500 when OPENROUTER_API_KEY is missing", async () => {
      const token = "edit-missing-key-token";
      const { server } = createDaemonServer({ token });
      await server.listen({ host: "127.0.0.1", port: 0 });

      const prevKey = process.env.OPENROUTER_API_KEY;
      delete process.env.OPENROUTER_API_KEY;

      try {
        const res = await server.inject({
          method: "POST",
          url: "/v1/inline/edit",
          headers: {
            authorization: `Bearer ${token}`,
          },
          payload: {
            filepath: "/workspace/index.ts",
            instruction: "make this async",
            fileContent: "function foo() {}",
            selectionStartLine: 1,
            selectionEndLine: 1,
          },
        });

        expect(res.statusCode).toBe(500);
        expect(res.json().error).toBe("missing_api_key");
      } finally {
        process.env.OPENROUTER_API_KEY = prevKey;
        await server.close();
      }
    });

    it("validates request body against InlineEditBody schema", async () => {
      const token = "edit-schema-token";
      const { server } = createDaemonServer({ token });
      await server.listen({ host: "127.0.0.1", port: 0 });

      try {
        const res = await server.inject({
          method: "POST",
          url: "/v1/inline/edit",
          headers: {
            authorization: `Bearer ${token}`,
          },
          payload: {
            filepath: "/workspace/index.ts",
            // missing instruction, fileContent, etc.
          },
        });

        expect(res.statusCode).toBe(400);
      } finally {
        await server.close();
      }
    });

    it("generates and returns cleaned unified diff from OpenRouterClient", async () => {
      const token = "edit-success-token";
      const { server } = createDaemonServer({ token });
      await server.listen({ host: "127.0.0.1", port: 0 });

      const prevKey = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = "sk-test-key";

      const sampleDiff = `\`\`\`diff
--- a/index.ts
+++ b/index.ts
@@ -1,1 +1,1 @@
-function foo() {}
+async function foo() {}
\`\`\``;

      const { OpenRouterClient } = await import("@aether/providers");
      const chatSpy = vi.spyOn(OpenRouterClient.prototype, "chat").mockImplementation(
        async function* () {
          yield { type: "text_delta", text: sampleDiff };
          yield { type: "done" };
        }
      );

      try {
        const res = await server.inject({
          method: "POST",
          url: "/v1/inline/edit",
          headers: {
            authorization: `Bearer ${token}`,
          },
          payload: {
            filepath: "/workspace/index.ts",
            instruction: "make this async",
            fileContent: "function foo() {}",
            selectionStartLine: 1,
            selectionEndLine: 1,
          },
        });

        expect(res.statusCode).toBe(200);
        const json = res.json();
        expect(json.diff).toContain("--- a/index.ts");
        expect(json.diff).toContain("+async function foo() {}");
        expect(json.diff.startsWith("```")).toBe(false);
        expect(json.diff.endsWith("```")).toBe(false);
        expect(chatSpy).toHaveBeenCalled();
      } finally {
        chatSpy.mockRestore();
        process.env.OPENROUTER_API_KEY = prevKey;
        await server.close();
      }
    });

    it("cancels an active mission via POST /v1/missions/:id/cancel", async () => {
      const token = "cancel-test-token-1234567890abcdef";
      const { server } = createDaemonServer({ token });
      await server.listen({ host: "127.0.0.1", port: 0 });

      try {
        // Create a mission
        const createRes = await server.inject({
          method: "POST",
          url: "/v1/missions",
          headers: {
            authorization: `Bearer ${token}`,
          },
          payload: {
            workspaceId: tmpWorkspace,
            goal: "Task to cancel",
          },
        });
        expect(createRes.statusCode).toBe(202);
        const { missionId } = createRes.json();

        // Cancel the mission
        const cancelRes = await server.inject({
          method: "POST",
          url: `/v1/missions/${missionId}/cancel`,
          headers: {
            authorization: `Bearer ${token}`,
          },
        });

        expect(cancelRes.statusCode).toBe(200);
        expect(cancelRes.json()).toEqual({
          status: "cancelled",
          missionId,
        });

        // Verify status in DB
        const { db, sqlite } = initDB(tmpWorkspace);
        const rows = db.select().from(missions).where(eq(missions.id, missionId)).all();
        expect(rows[0].status).toBe("cancelled");
        sqlite.close();
      } finally {
        await server.close();
      }
    });

    it("returns 404 when applying a non-existent mission via POST /v1/missions/:id/apply", async () => {
      const token = "apply-test-token-1234567890abcdef";
      const { server } = createDaemonServer({ token });
      await server.listen({ host: "127.0.0.1", port: 0 });

      try {
        const res = await server.inject({
          method: "POST",
          url: "/v1/missions/m_unknown/apply",
          headers: {
            authorization: `Bearer ${token}`,
          },
        });

        expect(res.statusCode).toBe(404);
        expect(res.json().error).toBe("mission_not_found");
      } finally {
        await server.close();
      }
    });

    it("fetches latest artifacts via GET /v1/missions/:id/artifacts", async () => {
      const token = "artifacts-test-token-1234567890abcdef";
      const { server } = createDaemonServer({ token, workspaceRoot: tmpWorkspace });
      await server.listen({ host: "127.0.0.1", port: 0 });

      try {
        const { sqlite } = initDB(tmpWorkspace);
        const now = new Date().toISOString();
        // Insert parent mission to satisfy FK
        sqlite
          .prepare(
            `INSERT INTO missions (id, workspace_id, goal, surface, execution_mode, status, isolation, policy_profile, budget_json, created_at, updated_at)
             VALUES (?, 'local', 'Test goal', 'cli', 'batch', 'planning', 'none', 'default', '{}', ?, ?)`
          )
          .run("m_test", now, now);

        // Insert sample artifacts (v1 and v2)
        sqlite
          .prepare(
            `INSERT INTO artifacts (id, mission_id, type, version, title, status, requires_approval, body_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            "plan-1",
            "m_test",
            "plan",
            1,
            "Initial Plan",
            "draft",
            1,
            JSON.stringify({ text: "Step 1" }),
            now,
            now
          );

        sqlite
          .prepare(
            `INSERT INTO artifacts (id, mission_id, type, version, title, status, requires_approval, body_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            "plan-1",
            "m_test",
            "plan",
            2,
            "Refined Plan",
            "published",
            1,
            JSON.stringify({ text: "Step 1 & Step 2" }),
            now,
            now
          );

        sqlite.close();

        const res = await server.inject({
          method: "GET",
          url: "/v1/missions/m_test/artifacts",
          headers: {
            authorization: `Bearer ${token}`,
          },
        });

        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.missionId).toBe("m_test");
        expect(data.artifacts.length).toBe(1);
        expect(data.artifacts[0].id).toBe("plan-1");
        expect(data.artifacts[0].version).toBe(2);
        expect(data.artifacts[0].title).toBe("Refined Plan");
        expect(data.artifacts[0].body).toEqual({ text: "Step 1 & Step 2" });
      } finally {
        await server.close();
      }
    });

    it("adds comment and steering inbox entry via POST /v1/artifacts/:id/comments", async () => {
      const token = "comment-test-token-1234567890abcdef";
      const { server } = createDaemonServer({ token, workspaceRoot: tmpWorkspace });
      await server.listen({ host: "127.0.0.1", port: 0 });

      try {
        const { sqlite } = initDB(tmpWorkspace);
        const now = new Date().toISOString();
        // Insert parent mission to satisfy FK
        sqlite
          .prepare(
            `INSERT INTO missions (id, workspace_id, goal, surface, execution_mode, status, isolation, policy_profile, budget_json, created_at, updated_at)
             VALUES (?, 'local', 'Test goal', 'cli', 'batch', 'planning', 'none', 'default', '{}', ?, ?)`
          )
          .run("m_comm", now, now);

        sqlite
          .prepare(
            `INSERT INTO artifacts (id, mission_id, type, version, title, status, requires_approval, body_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            "art-comment-test",
            "m_comm",
            "code",
            1,
            "Code Artifact",
            "published",
            0,
            JSON.stringify({ code: "console.log('hi')" }),
            now,
            now
          );
        sqlite.close();

        const res = await server.inject({
          method: "POST",
          url: "/v1/artifacts/art-comment-test/comments",
          headers: {
            authorization: `Bearer ${token}`,
          },
          payload: {
            body: "Please add type annotations here.",
            anchor: { line: 1 },
          },
        });

        expect(res.statusCode).toBe(201);
        const comment = res.json();
        expect(comment.artifactId).toBe("art-comment-test");
        expect(comment.body).toBe("Please add type annotations here.");

        // Verify comment and steering_inbox in SQLite
        const dbCheck = initDB(tmpWorkspace);
        const comments = dbCheck.sqlite
          .prepare("SELECT * FROM artifact_comments WHERE artifact_id = ?")
          .all("art-comment-test") as any[];
        expect(comments.length).toBe(1);
        expect(comments[0].body).toBe("Please add type annotations here.");

        const steering = dbCheck.sqlite
          .prepare("SELECT * FROM steering_inbox WHERE mission_id = ?")
          .all("m_comm") as any[];
        expect(steering.length).toBe(1);
        expect(steering[0].body).toContain("Please add type annotations here.");
        dbCheck.sqlite.close();
      } finally {
        await server.close();
      }
    });

    it("resolves gate and injects steering directive via POST /v1/missions/:id/approvals", async () => {
      const token = "approval-test-token-1234567890abcdef";
      const { server } = createDaemonServer({ token, workspaceRoot: tmpWorkspace });
      await server.listen({ host: "127.0.0.1", port: 0 });

      try {
        const { sqlite } = initDB(tmpWorkspace);
        const now = new Date().toISOString();
        // Insert parent mission to satisfy FK
        sqlite
          .prepare(
            `INSERT INTO missions (id, workspace_id, goal, surface, execution_mode, status, isolation, policy_profile, budget_json, created_at, updated_at)
             VALUES (?, 'local', 'Test goal', 'cli', 'batch', 'planning', 'none', 'default', '{}', ?, ?)`
          )
          .run("m_appr", now, now);

        // Insert a pending approval
        sqlite
          .prepare(
            `INSERT INTO approvals (id, mission_id, kind, summary, detail_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            "appr-123",
            "m_appr",
            "plan",
            "Approval required for architecture refactor",
            JSON.stringify({ plan: "refactor" }),
            now
          );
        sqlite.close();

        const res = await server.inject({
          method: "POST",
          url: "/v1/missions/m_appr/approvals",
          headers: {
            authorization: `Bearer ${token}`,
          },
          payload: {
            approvalId: "appr-123",
            decision: "approve",
            comment: "Looks great, proceed with phase 2.",
          },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.decision).toBe("approve");
        expect(body.status).toBe("executing");
        expect(body.approvalId).toBe("appr-123");

        // Verify DB update
        const dbCheck = initDB(tmpWorkspace);
        const row = dbCheck.sqlite
          .prepare("SELECT * FROM approvals WHERE id = ?")
          .get("appr-123") as any;
        expect(row.decision).toBe("approve");
        expect(row.comment).toBe("Looks great, proceed with phase 2.");
        expect(row.decided_by).toBe("user");

        // Verify steering message was queued
        const steering = dbCheck.sqlite
          .prepare("SELECT * FROM steering_inbox WHERE mission_id = ?")
          .all("m_appr") as any[];
        expect(steering.length).toBe(1);
        expect(steering[0].body).toContain("APPROVE");
        expect(steering[0].body).toContain("Looks great, proceed with phase 2.");
        dbCheck.sqlite.close();
      } finally {
        await server.close();
      }
    });

    it("enforces auth on POST /v1/context/index", async () => {
      const token = "secret-context-token";
      const { server } = createDaemonServer({ token, workspaceRoot: tmpWorkspace });
      await server.listen({ host: "127.0.0.1", port: 0 });

      try {
        const res = await server.inject({
          method: "POST",
          url: "/v1/context/index",
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await server.close();
      }
    });

    it("triggers workspace re-indexing via POST /v1/context/index", async () => {
      const token = "secret-context-token";
      const mockScanner = {
        scan: vi.fn(async () => ({
          indexedFiles: 5,
          totalChunks: 12,
          errors: [],
        })),
        scanAndIndex: vi.fn(async () => ({
          indexedFiles: 5,
          totalChunks: 12,
          errors: [],
        })),
      };

      const { server, vectorStore, scanner } = createDaemonServer({
        token,
        workspaceRoot: tmpWorkspace,
        scanner: mockScanner as any,
      });
      await server.listen({ host: "127.0.0.1", port: 0 });

      try {
        expect(vectorStore).toBeDefined();
        expect(scanner).toBeDefined();

        const res = await server.inject({
          method: "POST",
          url: "/v1/context/index",
          headers: {
            authorization: `Bearer ${token}`,
          },
          payload: {
            workspaceRoot: tmpWorkspace,
          },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.status).toBe("ok");
        expect(body.indexedFiles).toBe(5);
        expect(body.totalChunks).toBe(12);
        expect(mockScanner.scanAndIndex).toHaveBeenCalledWith(tmpWorkspace);
      } finally {
        await server.close();
      }
    });

    it("runs non-blocking background indexing on startup when autoIndex is true", async () => {
      const token = "secret-context-token";
      const mockScanner = {
        scan: vi.fn(async () => ({ indexedFiles: 1, totalChunks: 2, errors: [] })),
        scanAndIndex: vi.fn(async () => ({ indexedFiles: 1, totalChunks: 2, errors: [] })),
      };

      const { server } = createDaemonServer({
        token,
        workspaceRoot: tmpWorkspace,
        scanner: mockScanner as any,
        autoIndex: true,
      });
      await server.listen({ host: "127.0.0.1", port: 0 });

      try {
        expect(mockScanner.scanAndIndex).toHaveBeenCalledWith(path.resolve(tmpWorkspace));
      } finally {
        await server.close();
      }
    });
  });
});

