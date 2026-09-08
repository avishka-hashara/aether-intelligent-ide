import * as vscode from "vscode";
import { MissionEvent } from "@aether/protocol";

export class AgentSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "aether.sidebar";
  private view?: vscode.WebviewView;

  constructor(private readonly extensionUri?: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtmlForWebview();
  }

  /**
   * Posts a MissionEvent to the webview UI for debugging/inspection.
   */
  sendEventToUI(event: MissionEvent): void {
    if (this.view) {
      this.view.webview.postMessage({ type: "event", event });
    }
  }

  private getHtmlForWebview(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Aether Agent Chat</title>
  <style>
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
      padding: 10px;
      margin: 0;
    }
    h3 {
      margin-top: 0;
      margin-bottom: 8px;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-sideBarTitle-foreground, #ccc);
    }
    #chat-log {
      display: flex;
      flex-direction: column;
      gap: 8px;
      word-break: break-word;
    }
    .event-item {
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, #333);
      border-radius: 4px;
      padding: 8px;
    }
    .event-type {
      font-weight: 600;
      color: var(--vscode-textLink-foreground, #4daafc);
      margin-bottom: 4px;
      font-size: 12px;
    }
    .event-payload {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      white-space: pre-wrap;
      opacity: 0.9;
    }
  </style>
</head>
<body>
  <h3>Aether Agent Activity</h3>
  <div id="chat-log"></div>
  <script>
    (function() {
      const chatLog = document.getElementById("chat-log");

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (message && message.type === "event" && message.event) {
          const ev = message.event;
          const container = document.createElement("div");
          container.className = "event-item";

          const typeEl = document.createElement("div");
          typeEl.className = "event-type";
          typeEl.textContent = "[" + ev.type + "] (seq: " + ev.seq + ")";

          const payloadEl = document.createElement("div");
          payloadEl.className = "event-payload";
          payloadEl.textContent = typeof ev.payload === "string" 
            ? ev.payload 
            : JSON.stringify(ev.payload, null, 2);

          container.appendChild(typeEl);
          container.appendChild(payloadEl);
          chatLog.appendChild(container);

          container.scrollIntoView({ behavior: "smooth" });
        }
      });
    })();
  </script>
</body>
</html>`;
  }
}
