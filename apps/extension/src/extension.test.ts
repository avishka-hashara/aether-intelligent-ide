import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { WebSocketServer, WebSocket } from "ws";

// Hoist vscode mock to top level for Vitest
const mockCommands: Map<string, Function> = new Map();
const executedCommands: string[] = [];
const registeredViews: string[] = [];
const registeredCompletionProviders: any[] = [];
const createdPanels: any[] = [];
let mockDiagnostics: any[] = [];

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
    showWarningMessage: vi.fn(),
    showInputBox: vi.fn(),
    withProgress: vi.fn(async (_options: any, task: any) =>
      task(
        { report: vi.fn() },
        { isCancellationRequested: false, onCancellationRequested: vi.fn() }
      )
    ),
    createTextEditorDecorationType: vi.fn((opts: any) => ({
      dispose: vi.fn(),
      opts,
    })),
    registerWebviewViewProvider: vi.fn((viewId: string, _provider: any) => {
      registeredViews.push(viewId);
      return { dispose: vi.fn() };
    }),
    createWebviewPanel: vi.fn(
      (viewType: string, title: string, showOptions: any, options: any) => {
        const panel: any = {
          viewType,
          title,
          showOptions,
          options,
          webview: {
            html: "",
            options: {},
            postMessage: vi.fn(),
            asWebviewUri: vi.fn((uri: any) => ({
              toString: () =>
                `vscode-webview://${uri.path || uri.fsPath || "asset"}`,
            })),
            onDidReceiveMessage: vi.fn(),
          },
          reveal: vi.fn(),
          onDidDispose: vi.fn((cb: any) => {
            panel._disposeCb = cb;
            return { dispose: vi.fn() };
          }),
          dispose: vi.fn(() => {
            if (panel._disposeCb) panel._disposeCb();
          }),
        };
        createdPanels.push(panel);
        return panel;
      }
    ),
    activeTextEditor: undefined as any,
  },
  ProgressLocation: {
    SourceControl: 1,
    Window: 10,
    Notification: 15,
  },
  ViewColumn: {
    Active: -1,
    Beside: -2,
    One: 1,
    Two: 2,
    Three: 3,
  },
  languages: {
    registerInlineCompletionItemProvider: vi.fn((_selector: any, provider: any) => {
      registeredCompletionProviders.push(provider);
      return { dispose: vi.fn() };
    }),
    getDiagnostics: vi.fn((_uri: any) => mockDiagnostics),
  },
  Position: class {
    constructor(public line: number, public character: number) {}
  },
  Range: class {
    constructor(public start: any, public end: any) {}
  },
  InlineCompletionItem: class {
    constructor(public insertText: string, public range?: any) {}
  },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
  },
  CancellationError: class extends Error {
    constructor() {
      super("Canceled");
    }
  },
}));

import * as vscode from "vscode";
import { DaemonClient } from "./daemon-client.js";
import { DaemonManager } from "./daemon-manager.js";
import { WsClient } from "./ws-client.js";
import { AgentSidebarProvider } from "./sidebar.js";
import { AetherCompletionProvider } from "./completion.js";
import { ContextBridge } from "./context-bridge.js";
import { InlineDiffManager } from "./inline-diff.js";
import { executeInlineEdit } from "./inline-edit.js";
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
    registeredCompletionProviders.length = 0;
    mockDiagnostics = [];
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

  describe("AetherCompletionProvider", () => {
    it("extracts prefix/suffix, debounces, and returns inline completion item", async () => {
      fs.writeFileSync(
        fakeConfigFile,
        JSON.stringify({ port: 12345, token: "test-token" })
      );

      const daemonClient = new DaemonClient(fakeConfigFile);
      const provider = new AetherCompletionProvider(daemonClient, 10); // short debounce for test

      let fetchPayload: any = null;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (_url, opts) => {
          fetchPayload = JSON.parse(opts.body);
          return {
            ok: true,
            json: async () => ({ completion: "world" }),
          };
        })
      );

      const mockDoc = {
        lineCount: 2,
        lineAt: () => ({ text: "end" }),
        getText: vi.fn((range: any) => {
          if (range.start.line === 0 && range.start.character === 0) {
            return "hello ";
          }
          return " end";
        }),
        uri: { fsPath: "/workspace/index.ts" },
        languageId: "typescript",
      } as any;

      const mockPosition = { line: 0, character: 6 } as any;
      const mockToken = {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
      } as any;

      const items = await provider.provideInlineCompletionItems(
        mockDoc,
        mockPosition,
        {} as any,
        mockToken
      );

      expect(items).toBeDefined();
      expect(items).toHaveLength(1);
      expect(items![0].insertText).toBe("world");
      expect(fetchPayload).toEqual({
        prefix: "hello ",
        suffix: " end",
        filepath: "/workspace/index.ts",
        language: "typescript",
      });
    });

    it("returns undefined if cancelled during debounce", async () => {
      const daemonClient = new DaemonClient(fakeConfigFile);
      const provider = new AetherCompletionProvider(daemonClient, 50);

      const mockDoc = {
        lineCount: 1,
        lineAt: () => ({ text: "" }),
        getText: () => "",
        uri: { fsPath: "/test" },
        languageId: "typescript",
      } as any;

      const mockToken = {
        isCancellationRequested: true,
        onCancellationRequested: vi.fn(),
      } as any;

      const items = await provider.provideInlineCompletionItems(
        mockDoc,
        { line: 0, character: 0 } as any,
        {} as any,
        mockToken
      );

      expect(items).toBeUndefined();
    });
  });

  describe("ContextBridge", () => {
    it("maps LSP diagnostics into lightweight DiagnosticItem array", () => {
      const bridge = new ContextBridge();

      mockDiagnostics = [
        {
          message: "Variable 'x' is unused",
          range: {
            start: { line: 4, character: 2 },
            end: { line: 4, character: 7 },
          },
          severity: 1, // Warning
          source: "typescript",
          code: 6133,
        },
      ];

      const mockDoc = { uri: { fsPath: "/test.ts" } } as any;
      const result = bridge.getActiveDiagnostics(mockDoc);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        message: "Variable 'x' is unused",
        lineNumber: 5,
        startColumn: 3,
        endColumn: 8,
        severity: "warning",
        source: "typescript",
        code: 6133,
      });
    });
  });

  describe("Extension Activation", () => {
    it("registers commands, sidebar provider, completion provider, and wires focus command", async () => {
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
      expect(registeredCompletionProviders).toHaveLength(1);

      // Verify aether.chat.focus executes aether.sidebar.focus
      const chatFocusHandler = mockCommands.get("aether.chat.focus");
      expect(chatFocusHandler).toBeDefined();
      chatFocusHandler!();
      expect(executedCommands).toContain("aether.sidebar.focus");

      // Verify aether.inlineEdit is registered as an async handler
      const inlineEditHandler = mockCommands.get("aether.inlineEdit");
      expect(inlineEditHandler).toBeDefined();

      deactivate();
    });
  });

  describe("InlineDiffManager", () => {
    it("configures added and removed decoration types with required styles", () => {
      const manager = new InlineDiffManager();

      expect(vscode.window.createTextEditorDecorationType).toHaveBeenCalledWith(
        expect.objectContaining({
          backgroundColor: "rgba(0, 255, 0, 0.2)",
        })
      );
      expect(vscode.window.createTextEditorDecorationType).toHaveBeenCalledWith(
        expect.objectContaining({
          backgroundColor: "rgba(255, 0, 0, 0.2)",
          textDecoration: "line-through",
        })
      );

      expect(manager.addedDecoration).toBeDefined();
      expect(manager.removedDecoration).toBeDefined();

      const disposeSpyAdded = vi.spyOn(manager.addedDecoration, "dispose");
      const disposeSpyRemoved = vi.spyOn(manager.removedDecoration, "dispose");
      manager.dispose();
      expect(disposeSpyAdded).toHaveBeenCalled();
      expect(disposeSpyRemoved).toHaveBeenCalled();
    });

    it("parses diff, edits document, and applies decorations to added lines", async () => {
      const manager = new InlineDiffManager();
      const diffStr = `--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
`;

      const originalLines = ["const a = 1;", "const b = 2;"];
      let currentDocText = originalLines.join("\n");

      const mockEditor: any = {
        document: {
          getText: vi.fn(() => currentDocText),
          lineCount: 2,
          lineAt: vi.fn((idx: number) => ({
            text: idx === 0 ? "const a = 1;" : idx === 1 ? "const b = 3;" : "const c = 4;",
          })),
        },
        edit: vi.fn(async (callback: (builder: any) => void) => {
          const builder = {
            replace: vi.fn((_range: any, text: string) => {
              currentDocText = text;
            }),
          };
          callback(builder);
          // Simulate updated lineCount
          mockEditor.document.lineCount = 3;
          return true;
        }),
        setDecorations: vi.fn(),
      };

      const result = await manager.applyAndRenderDiff(mockEditor, diffStr);
      expect(result).toBe(true);
      expect(mockEditor.edit).toHaveBeenCalled();
      expect(mockEditor.setDecorations).toHaveBeenCalledWith(
        manager.addedDecoration,
        expect.any(Array)
      );

      // Verify decoration ranges were calculated for added lines
      const addedCalls = mockEditor.setDecorations.mock.calls.find(
        (call: any[]) => call[0] === manager.addedDecoration
      );
      expect(addedCalls).toBeDefined();
      expect(addedCalls[1].length).toBe(2); // 2 added lines

      // Test clearDecorations
      manager.clearDecorations(mockEditor);
      expect(mockEditor.setDecorations).toHaveBeenCalledWith(manager.addedDecoration, []);
      expect(mockEditor.setDecorations).toHaveBeenCalledWith(manager.removedDecoration, []);
    });

    it("returns false gracefully on invalid diff", async () => {
      const manager = new InlineDiffManager();
      const mockEditor: any = {
        document: {
          getText: vi.fn(() => "hello world"),
          lineCount: 1,
        },
        edit: vi.fn(),
        setDecorations: vi.fn(),
      };

      const result = await manager.applyAndRenderDiff(mockEditor, "not a valid diff");
      expect(result).toBe(false);
      expect(mockEditor.edit).not.toHaveBeenCalled();
    });
  });

  describe("executeInlineEdit", () => {
    let mockEditor: any;
    let mockDaemonClient: any;
    let diffManager: InlineDiffManager;

    beforeEach(() => {
      diffManager = new InlineDiffManager();
      mockDaemonClient = {
        getConnectionInfo: vi.fn(() => ({
          port: 54321,
          token: "inline-edit-token",
        })),
      };

      mockEditor = {
        document: {
          uri: { fsPath: "/workspace/src/test.ts" },
          getText: vi.fn(() => "function greet() {\n  return 'hello';\n}\n"),
          lineCount: 3,
          lineAt: vi.fn((idx: number) => ({ text: "line " + idx })),
        },
        selection: {
          start: { line: 0, character: 0 },
          end: { line: 2, character: 1 },
        },
        edit: vi.fn(async (cb: any) => {
          cb({ replace: vi.fn() });
          return true;
        }),
        setDecorations: vi.fn(),
      };

      vscode.window.activeTextEditor = mockEditor;
    });

    afterEach(() => {
      vscode.window.activeTextEditor = undefined;
    });

    it("does nothing if no activeTextEditor exists", async () => {
      vscode.window.activeTextEditor = undefined;
      await executeInlineEdit(mockDaemonClient, diffManager);
      expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    });

    it("does nothing if user cancels the input prompt", async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);
      await executeInlineEdit(mockDaemonClient, diffManager);
      expect(vscode.window.withProgress).not.toHaveBeenCalled();
    });

    it("executes inline edit, applies diff, and clears decorations on Accept", async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("make async");

      const fakeDiff = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,3 @@
-function greet() {
+async function greet() {
   return 'hello';
 }
`;
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ diff: fakeDiff }),
      });
      vi.stubGlobal("fetch", fetchSpy);

      vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce("Accept" as any);

      await executeInlineEdit(mockDaemonClient, diffManager);

      // Verify progress notification
      expect(vscode.window.withProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Aether is editing...",
        }),
        expect.any(Function)
      );

      // Verify network request to daemon
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://127.0.0.1:54321/v1/inline/edit",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer inline-edit-token",
          },
          body: JSON.stringify({
            filepath: "/workspace/src/test.ts",
            instruction: "make async",
            fileContent: "function greet() {\n  return 'hello';\n}\n",
            selectionStartLine: 1,
            selectionEndLine: 3,
          }),
        })
      );

      // Verify follow-up prompt
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        "Accept changes?",
        "Accept",
        "Reject"
      );

      // Accept does not trigger undo
      expect(executedCommands).not.toContain("undo");

      // Decorations are cleared
      expect(mockEditor.setDecorations).toHaveBeenCalledWith(diffManager.addedDecoration, []);
    });

    it("executes undo when user selects Reject", async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("rename function");

      const fakeDiff = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,3 @@
-function greet() {
+function hello() {
   return 'hello';
 }
`;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ diff: fakeDiff }),
        })
      );

      vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce("Reject" as any);

      await executeInlineEdit(mockDaemonClient, diffManager);

      // Reject triggers undo command
      expect(executedCommands).toContain("undo");

      // Decorations are cleared
      expect(mockEditor.setDecorations).toHaveBeenCalledWith(diffManager.addedDecoration, []);
    });
  });

  describe("ManagerPanelManager & Webview Panel", () => {
    it("creates webview panel and wires wsClient events", async () => {
      const { ManagerPanelManager } = await import("./manager-panel.js");
      const { WsClient } = await import("./ws-client.js");

      const mockContext = {
        extensionUri: { fsPath: "/dummy/ext" },
        extensionPath: path.resolve("./"),
        subscriptions: [],
      } as any;

      const mockWs = new WsClient();
      const panel = ManagerPanelManager.open(mockContext, mockWs);

      expect(panel).toBeDefined();
      expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
        "aether.manager",
        "Aether Missions",
        expect.anything(),
        expect.anything()
      );

      // Verify event forwarding from wsClient to panel webview
      const testEvent: any = {
        schemaVersion: 1,
        seq: 1,
        id: "ev-ws-1",
        missionId: "m_ws_100",
        ts: new Date().toISOString(),
        type: "mission.created",
        payload: { status: "executing" },
      };

      mockWs.emit("event", testEvent);
      expect(panel.webview.postMessage).toHaveBeenCalledWith({
        type: "event",
        event: testEvent,
      });

      // Revealing existing panel
      const panel2 = ManagerPanelManager.open(mockContext, mockWs);
      expect(panel2).toBe(panel);
      expect(panel.reveal).toHaveBeenCalled();

      // Clean up panel
      panel.dispose();
    });

    it("posts init message with port and token to webview panel", async () => {
      const { ManagerPanelManager } = await import("./manager-panel.js");
      const { WsClient } = await import("./ws-client.js");

      // Write mock daemon config
      const daemonConfigFile = path.join(os.homedir(), ".aether", "daemon.json");
      fs.mkdirSync(path.dirname(daemonConfigFile), { recursive: true });
      const origConfig = fs.existsSync(daemonConfigFile)
        ? fs.readFileSync(daemonConfigFile, "utf8")
        : null;

      fs.writeFileSync(
        daemonConfigFile,
        JSON.stringify({ port: 9876, token: "test-tok-xyz" })
      );

      const mockContext = {
        extensionUri: { fsPath: "/dummy/ext" },
        extensionPath: path.resolve("./"),
        subscriptions: [],
      } as any;

      const mockWs = new WsClient();
      const panel = ManagerPanelManager.open(mockContext, mockWs);

      expect(panel.webview.postMessage).toHaveBeenCalledWith({
        type: "init",
        port: 9876,
        token: "test-tok-xyz",
      });

      panel.dispose();

      // Restore
      if (origConfig) {
        fs.writeFileSync(daemonConfigFile, origConfig);
      }
    });

    it("triggers ManagerPanelManager.open from aether.openManager command", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ status: "ok" }),
        })
      );

      const subscriptions: any[] = [];
      const context = {
        subscriptions,
        extensionPath: tmpDir,
      } as any;
      await activate(context);

      const openManagerHandler = mockCommands.get("aether.openManager");
      expect(openManagerHandler).toBeDefined();

      createdPanels.length = 0;
      openManagerHandler!();
      expect(vscode.window.createWebviewPanel).toHaveBeenCalled();
      deactivate();
    });
  });
});
