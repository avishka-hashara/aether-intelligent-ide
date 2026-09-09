export type WebviewToHost =
  | { type: "ready" }
  | { type: "cancel"; missionId: string }
  | { type: "apply"; missionId: string }
  | { type: "steer"; missionId: string; text: string }
  | { type: "subscribe"; missionIds: string[] }
  | { type: "unsubscribe"; missionIds: string[] };

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let vscodeApi: VsCodeApi | null = null;

/**
 * Returns the acquired VS Code API instance safely, or null if outside VS Code webview.
 */
export function getVsCodeApi(): VsCodeApi | null {
  if (vscodeApi) {
    return vscodeApi;
  }
  try {
    if (typeof acquireVsCodeApi === "function") {
      vscodeApi = acquireVsCodeApi();
      return vscodeApi;
    }
  } catch {
    // acquireVsCodeApi is not defined when running in a standalone browser
  }
  return null;
}

/**
 * Sends a message from the Webview React app to the extension host.
 */
export function postMessage(message: WebviewToHost): void {
  const api = getVsCodeApi();
  if (api) {
    api.postMessage(message);
  } else {
    // Dev/browser fallback
    console.log("[ManagerUI -> VSCode Host]", message);
    window.parent?.postMessage(message, "*");
  }
}
