import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Hoist vscode mock to top level for Vitest
const mockCommands: string[] = [];
vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn((cmd: string, _handler: any) => {
      mockCommands.push(cmd);
      return { dispose: vi.fn() };
    }),
  },
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
}));

import { DaemonClient } from "./daemon-client.js";
import { DaemonManager } from "./daemon-manager.js";
import { activate, deactivate } from "./extension.js";

describe("VS Code Extension Daemon Client & Lifecycle (@aether/extension)", () => {
  let tmpDir: string;
  let fakeConfigFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-ext-test-"));
    fakeConfigFile = path.join(tmpDir, "daemon.json");
    mockCommands.length = 0;
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

  describe("Extension Activation", () => {
    it("registers commands and activates without crashing", async () => {
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

      expect(mockCommands).toContain("aether.chat.focus");
      expect(mockCommands).toContain("aether.inlineEdit");
      expect(mockCommands).toContain("aether.openManager");
      expect(subscriptions).toHaveLength(3);

      deactivate();
    });
  });
});
