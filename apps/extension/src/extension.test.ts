import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { WebSocketServer, WebSocket } from "ws";

// Hoist vscode mock to top level for Vitest
const mockCommands: Map<string, Function> = new Map();
const executedCommands: string[] = [];
const registeredViews: string[] = [];

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn((cmd: string, handler: any) => {
      mockCommands.set(cmd, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn((cmd: string, ..._args: any[]) => {
      executedCommands.push(cmd);
      return Promise.resolve();
    }),
  },
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    registerWebviewViewProvider: vi.fn((viewId: string, _provider: any) => {
      registeredViews.push(viewId);
      return { dispose: vi.fn() };
    }),
  },
}));

import { DaemonClient } from "./daemon-client.js";
import { DaemonManager } from "./daemon-manager.js";
import { WsClient } from "./ws-client.js";
import { AgentSidebarProvider } from "./sidebar.js";
import { activate, deactivate } from "./extension.js";
import { MissionEvent } from "@aether/protocol";

describe("VS Code Extension Daemon Client & Lifecycle (@aether/extension)", () => {
  let tmpDir: string;
  let fakeConfigFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-ext-test-"));
    fakeConfigFile = path.join(tmpDir, "daemon.json");
    mockCommands.clear();
    executedCommands.length = 0;
    registeredViews.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  describe("DaemonClient", () => {
    it("returns null and false when daemon.json is missing", async () => {
      const client = new DaemonClient(fakeConfigFile);
      expect(client.getConnectionInfo()).toBeNull();

      const pingResult = await client.ping();
      expect(pingResult).toBe(false);
    });

    it("reads connection metadata and pings health endpoint successfully", async () => {
      fs.writeFileSync(
        fakeConfigFile,
        JSON.stringify({ port: 12345, token: "test-token", pid: 9999 })
      );

      const client = new DaemonClient(fakeConfigFile);
      const info = client.getConnectionInfo();
      expect(info).toEqual({ port: 12345, token: "test-token", pid: 9999 });

      // Mock global fetch
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok", version: "1.0.0" }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const pingSuccess = await client.ping();
      expect(pingSuccess).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:12345/v1/health",
        expect.objectContaining({
          headers: { Authorization: "Bearer test-token" },
        })
      );
    });

    it("returns false if ping fails or returns non-ok status", async () => {
      fs.writeFileSync(
        fakeConfigFile,
        JSON.stringify({ port: 12345, token: "bad-token" })
      );

      const client = new DaemonClient(fakeConfigFile);

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
        })
      );

      const pingFail = await client.ping();
      expect(pingFail).toBe(false);
    });
  });

  describe("DaemonManager", () => {
    it("does nothing if daemon is already running", async () => {
      const mockClient = {
        ping: vi.fn().mockResolvedValue(true),
        getConnectionInfo: vi.fn(),
      } as unknown as DaemonClient;

      const manager = new DaemonManager(mockClient);
      const context = {
        extensionPath: tmpDir,
      } as any;

      await manager.ensureStarted(context);
      expect(mockClient.ping).toHaveBeenCalledTimes(1);
    });

    it("polls and succeeds when daemon comes online", async () => {
      let pingCalls = 0;
      const mockClient = {
        ping: vi.fn().mockImplementation(async () => {
          pingCalls++;
          return pingCalls >= 2; // Fails first, succeeds on second poll
        }),
        getConnectionInfo: vi.fn(),
      } as unknown as DaemonClient;

      // Create fake daemon bundle file
      const daemonDist = path.join(tmpDir, "daemon", "dist");
      fs.mkdirSync(daemonDist, { recursive: true });
      fs.writeFileSync(path.join(daemonDist, "index.js"), "// fake daemon");

      const manager = new DaemonManager(mockClient);
      const context = {
        extensionPath: path.join(tmpDir, "extension"),
      } as any;

      await manager.ensureStarted(context);
      expect(pingCalls).toBeGreaterThanOrEqual(2);
    });

    it("throws timeout error if daemon fails to start after polling", async () => {
      const mockClient = {
        ping: vi.fn().mockResolvedValue(false),
        getConnectionInfo: vi.fn(),
      } as unknown as DaemonClient;

      // Create fake daemon bundle file
      const daemonDist = path.join(tmpDir, "daemon", "dist");
      fs.mkdirSync(daemonDist, { recursive: true });
      fs.writeFileSync(path.join(daemonDist, "index.js"), "// fake daemon");

      const manager = new DaemonManager(mockClient);
      const context = {
        extensionPath: path.join(tmpDir, "extension"),
      } as any;

      await expect(manager.ensureStarted(context)).rejects.toThrow(
        /Timed out waiting for Aether Agent Daemon/
      );
    }, 10000);
  });

  describe("WsClient", () => {
    let wss: WebSocketServer;
    let wsPort: number;

    beforeEach(async () => {
      wss = new WebSocketServer({ port: 0 });
      await new Promise<void>((resolve) => {
        wss.on("listening", () => {
          const addr = wss.address();
          wsPort = typeof addr === "object" && addr ? addr.port : 0;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    });

    it("connects, subscribes, and emits parsed MissionEvents", async () => {
      const client = new WsClient();
      let serverSocket: WebSocket | null = null;

      wss.on("connection", (socket) => {
        serverSocket = socket;
      });

      const events: MissionEvent[] = [];
      client.on("event", (ev) => {
        events.push(ev);
      });

      client.connect(wsPort, "test-token");

      // Wait for connection
      await new Promise<void>((resolve) => {
        client.on("connected", () => resolve());
      });

      const sampleEvent: MissionEvent = {
        schemaVersion: 1,
        seq: 1,
        id: "evt_1",
        missionId: "m_1",
        ts: new Date().toISOString(),
        type: "turn.text_delta",
        payload: { text: "hello from daemon" },
      };

      (serverSocket as any)?.send(JSON.stringify(sampleEvent));

      // Wait for message receipt
      await new Promise((r) => setTimeout(r, 100));

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe("evt_1");
      expect((events[0].payload as any).text).toBe("hello from daemon");

      client.disconnect();
    });
  });

  describe("AgentSidebarProvider", () => {
    it("configures webview options and renders HTML with chat-log div", () => {
      const provider = new AgentSidebarProvider();
      let postedMessage: any = null;

      const mockWebview = {
        options: {},
        html: "",
        postMessage: vi.fn((msg: any) => {
          postedMessage = msg;
          return Promise.resolve(true);
        }),
      };

      const mockWebviewView = {
        webview: mockWebview,
      } as any;

      provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);

      expect(mockWebview.options).toEqual({ enableScripts: true });
      expect(mockWebview.html).toContain('id="chat-log"');
      expect(mockWebview.html).toContain('addEventListener("message"');

      // Test sendEventToUI
      const testEvent: MissionEvent = {
        schemaVersion: 1,
        seq: 1,
        id: "evt_test",
        missionId: "m_test",
        ts: new Date().toISOString(),
        type: "tool.started",
        payload: { name: "fs.read" },
      };

      provider.sendEventToUI(testEvent);
      expect(postedMessage).toEqual({ type: "event", event: testEvent });
    });
  });

  describe("Extension Activation", () => {
    it("registers commands, sidebar provider, and wires focus command", async () => {
      const subscriptions: any[] = [];

      // Create fake daemon running
      fs.writeFileSync(
        fakeConfigFile,
        JSON.stringify({ port: 12345, token: "test-token" })
      );
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ status: "ok" }),
        })
      );

      const context = {
        subscriptions,
        extensionPath: tmpDir,
      } as any;

      await activate(context);

      expect(mockCommands.has("aether.chat.focus")).toBe(true);
      expect(mockCommands.has("aether.inlineEdit")).toBe(true);
      expect(mockCommands.has("aether.openManager")).toBe(true);
      expect(registeredViews).toContain("aether.sidebar");

      // Verify aether.chat.focus executes aether.sidebar.focus
      const chatFocusHandler = mockCommands.get("aether.chat.focus");
      expect(chatFocusHandler).toBeDefined();
      chatFocusHandler!();
      expect(executedCommands).toContain("aether.sidebar.focus");

      deactivate();
    });
  });
});
