import * as vscode from "vscode";
import { DaemonClient } from "./daemon-client.js";
import { DaemonManager } from "./daemon-manager.js";
import { WsClient } from "./ws-client.js";
import { AgentSidebarProvider } from "./sidebar.js";

export * from "./daemon-client.js";
export * from "./daemon-manager.js";
export * from "./ws-client.js";
export * from "./sidebar.js";

let wsClient: WsClient | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const daemonClient = new DaemonClient();
  const daemonManager = new DaemonManager(daemonClient);

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

  // Register commands
  const commandChatFocus = vscode.commands.registerCommand(
    "aether.chat.focus",
    () => {
      vscode.commands.executeCommand("aether.sidebar.focus");
    }
  );

  const commandInlineEdit = vscode.commands.registerCommand(
    "aether.inlineEdit",
    () => {
      vscode.window.showInformationMessage("Aether: Command Executed");
    }
  );

  const commandOpenManager = vscode.commands.registerCommand(
    "aether.openManager",
    () => {
      vscode.window.showInformationMessage("Aether: Command Executed");
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
