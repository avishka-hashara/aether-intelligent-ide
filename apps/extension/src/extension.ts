import * as vscode from "vscode";
import { DaemonManager } from "./daemon-manager.js";

export * from "./daemon-client.js";
export * from "./daemon-manager.js";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const daemonManager = new DaemonManager();

  try {
    await daemonManager.ensureStarted(context);
  } catch (err: any) {
    vscode.window.showErrorMessage(
      `Failed to start Aether Agent Daemon: ${err?.message || err}`
    );
  }

  // Register the commands specified in package.json contributes.commands
  const commandChatFocus = vscode.commands.registerCommand(
    "aether.chat.focus",
    () => {
      vscode.window.showInformationMessage("Aether: Command Executed");
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
  // Do not kill the daemon here; it must survive window reloads
}
