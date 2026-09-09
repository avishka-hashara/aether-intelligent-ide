import * as vscode from "vscode";
import { DaemonClient } from "./daemon-client.js";
import { DaemonManager } from "./daemon-manager.js";
import { WsClient } from "./ws-client.js";
import { AgentSidebarProvider } from "./sidebar.js";
import { AetherCompletionProvider } from "./completion.js";
import { ContextBridge } from "./context-bridge.js";
import { InlineDiffManager } from "./inline-diff.js";
import { executeInlineEdit } from "./inline-edit.js";
import { ManagerPanelManager } from "./manager-panel.js";

export * from "./daemon-client.js";
export * from "./daemon-manager.js";
export * from "./ws-client.js";
export * from "./sidebar.js";
export * from "./completion.js";
export * from "./context-bridge.js";
export * from "./inline-diff.js";
export * from "./inline-edit.js";
export * from "./manager-panel.js";

let wsClient: WsClient | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const daemonClient = new DaemonClient();
  const daemonManager = new DaemonManager(daemonClient);

  // Register inline completion provider
  const completionProvider = new AetherCompletionProvider(daemonClient);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      completionProvider
    )
  );

  // Instantiate AgentSidebarProvider and register view provider
  const sidebarProvider = new AgentSidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      AgentSidebarProvider.viewType,
      sidebarProvider
    )
  );

  try {
    await daemonManager.ensureStarted(context);

    // Retrieve daemon connection metadata and connect WebSocket bridge
    const daemonInfo = daemonClient.getConnectionInfo();
    if (daemonInfo) {
      wsClient = new WsClient();
      wsClient.connect(daemonInfo.port, daemonInfo.token);

      wsClient.on("event", (event) => {
        sidebarProvider.sendEventToUI(event);
      });
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(
      `Failed to start Aether Agent Daemon: ${err?.message || err}`
    );
  }

  const inlineDiffManager = new InlineDiffManager();
  context.subscriptions.push(inlineDiffManager);

  // Register commands
  const commandChatFocus = vscode.commands.registerCommand(
    "aether.chat.focus",
    () => {
      vscode.commands.executeCommand("aether.sidebar.focus");
    }
  );

  const commandInlineEdit = vscode.commands.registerCommand(
    "aether.inlineEdit",
    async () => {
      await executeInlineEdit(daemonClient, inlineDiffManager);
    }
  );

  const commandOpenManager = vscode.commands.registerCommand(
    "aether.openManager",
    () => {
      ManagerPanelManager.open(context, wsClient);
    }
  );

  context.subscriptions.push(
    commandChatFocus,
    commandInlineEdit,
    commandOpenManager
  );
}

export function deactivate(): void {
  if (wsClient) {
    wsClient.disconnect();
    wsClient = null;
  }
}
