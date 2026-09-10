import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";
import { DaemonClient } from "./daemon-client.js";

export class DaemonManager {
  constructor(readonly daemonClient: DaemonClient = new DaemonClient()) {}

  /**
   * Ensures the Aether Agent Daemon is running.
   * If already responsive, returns immediately.
   * Otherwise, spawns the daemon detached, unrefs it, and polls until healthy.
   */
  async ensureStarted(
    _context?: vscode.ExtensionContext,
    timeoutMs: number = 15000
  ): Promise<void> {
    // 1. Check if daemon is already healthy
    const isRunning = await this.daemonClient.ping();
    if (isRunning) {
      return;
    }

    // 2. Resolve path to the daemon bundle
    const prodPath = path.join(__dirname, "daemon/index.js");
    const devPath = path.join(__dirname, "../../daemon/dist/index.js");
    const daemonPath = fs.existsSync(prodPath) ? prodPath : devPath;

    if (!fs.existsSync(daemonPath)) {
      throw new Error(`Aether daemon bundle not found at ${daemonPath}`);
    }

    // 3. Spawn daemon detached and unref so it survives extension host reloads
    const child = child_process.spawn("node", [daemonPath], {
      detached: true,
      stdio: "ignore",
      cwd: path.resolve(__dirname, "../../.."),
      env: process.env,
    });

    child.unref();

    // 4. Poll daemonClient.ping() every 500ms (up to 15000ms / 30 attempts)
    const intervalMs = 500;
    const maxAttempts = Math.ceil(timeoutMs / intervalMs);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const healthy = await this.daemonClient.ping();
      if (healthy) {
        return;
      }
    }

    throw new Error(
      `Timed out waiting for Aether Agent Daemon to start after ${maxAttempts * intervalMs}ms.`
    );
  }
}
