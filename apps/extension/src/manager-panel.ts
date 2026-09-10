import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { WsClient } from "./ws-client.js";
import { DaemonClient } from "./daemon-client.js";
import { MissionEvent } from "@aether/protocol";

export class ManagerPanelManager {
  private static currentPanel: vscode.WebviewPanel | undefined;
  private static wsListener: ((event: MissionEvent) => void) | undefined;

  private static getDistPath(context?: vscode.ExtensionContext): string | undefined {
    const prodPath = path.join(__dirname, "manager-ui/index.html");
    const devPath = path.join(__dirname, "../../manager-ui/dist/index.html");
    const uiPath = fs.existsSync(prodPath) ? prodPath : devPath;

    if (fs.existsSync(uiPath)) {
      return path.dirname(uiPath);
    }

    if (context) {
      const distCandidates = [
        path.resolve(context.extensionPath, "dist", "manager-ui"),
        path.resolve(context.extensionPath, "..", "manager-ui", "dist"),
        path.resolve(context.extensionPath, "manager-ui"),
      ];

      return distCandidates.find((dir) =>
        fs.existsSync(path.join(dir, "index.html"))
      );
    }

    return undefined;
  }

  /**
   * Opens or reveals the Aether Mission Control webview panel.
   */
  public static open(
    context: vscode.ExtensionContext,
    wsClient?: WsClient | null
  ): vscode.WebviewPanel {
    const column = vscode.ViewColumn.One;

    // If panel already exists, reveal it
    if (ManagerPanelManager.currentPanel) {
      ManagerPanelManager.currentPanel.reveal(column);
      return ManagerPanelManager.currentPanel;
    }

    const distPath = ManagerPanelManager.getDistPath(context);

    const panel = vscode.window.createWebviewPanel(
      "aether.manager",
      "Aether Missions",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: distPath
          ? [vscode.Uri.file(distPath), context.extensionUri]
          : [context.extensionUri],
      }
    );

    ManagerPanelManager.currentPanel = panel;

    // Set panel HTML by reading dist/index.html and resolving assets
    panel.webview.html = ManagerPanelManager.getHtmlForWebview(
      panel.webview,
      context
    );

    // Retrieve daemon connection info and send initial configuration to webview
    const daemonClient = new DaemonClient();
    const daemonInfo = daemonClient.getConnectionInfo();
    if (daemonInfo) {
      panel.webview.postMessage({
        type: "init",
        port: daemonInfo.port,
        token: daemonInfo.token,
      });
    }

    // Also respond to webview "ready" event with daemon info
    panel.webview.onDidReceiveMessage((message: any) => {
      if (message?.type === "ready") {
        const info = daemonClient.getConnectionInfo();
        if (info) {
          panel.webview.postMessage({
            type: "init",
            port: info.port,
            token: info.token,
          });
        }
      }
    });

    // Wire WsClient to forward all events to the webview panel
    if (wsClient) {
      const listener = (event: MissionEvent) => {
        panel.webview.postMessage({ type: "event", event });
      };
      ManagerPanelManager.wsListener = listener;
      wsClient.on("event", listener);
    }

    panel.onDidDispose(() => {
      if (wsClient && ManagerPanelManager.wsListener) {
        wsClient.removeListener("event", ManagerPanelManager.wsListener);
        ManagerPanelManager.wsListener = undefined;
      }
      ManagerPanelManager.currentPanel = undefined;
    });

    return panel;
  }

  /**
   * Reads apps/manager-ui/dist/index.html and transforms asset URLs to webview.asWebviewUri(...)
   */
  public static getHtmlForWebview(
    webview: vscode.Webview,
    context: vscode.ExtensionContext
  ): string {
    const distPath = ManagerPanelManager.getDistPath(context);

    if (!distPath) {
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Aether Missions</title>
  <style>
    body { font-family: sans-serif; padding: 24px; color: #ccc; background: #1e1e1e; }
    h2 { color: #58a6ff; }
  </style>
</head>
<body>
  <h2>Aether Mission Control</h2>
  <p>Manager UI bundle not found at <code>apps/manager-ui/dist/index.html</code>. Please run <code>pnpm --filter @aether/manager-ui build</code>.</p>
</body>
</html>`;
    }

    const indexPath = path.join(distPath, "index.html");
    let html = fs.readFileSync(indexPath, "utf8");

    // Transform relative assets into webview URIs
    const distUri = vscode.Uri.file(distPath);

    html = html.replace(
      /(href|src)=["'](?:\.?\/)?assets\/([^"']+)["']/g,
      (_match, attr, file) => {
        const fileUri = vscode.Uri.joinPath(distUri, "assets", file);
        const webviewUri = webview.asWebviewUri(fileUri);
        return `${attr}="${webviewUri.toString()}"`;
      }
    );

    return html;
  }
}
