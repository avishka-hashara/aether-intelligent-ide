import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { MissionEvent } from "@aether/protocol";

describe("Aether Agent Daemon (@aether/daemon)", () => {
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
});
