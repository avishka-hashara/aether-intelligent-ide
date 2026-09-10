import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface DaemonConnectionInfo {
  port: number;
  token: string;
  pid?: number;
}

export class DaemonClient {
  private daemonConfigPath: string;

  constructor(customConfigPath?: string) {
    this.daemonConfigPath =
      customConfigPath || path.join(os.homedir(), ".aether", "daemon.json");
  }

  /**
   * Reads ~/.aether/daemon.json to retrieve the daemon port and token.
   * Returns null if file is missing or invalid.
   */
  getConnectionInfo(): DaemonConnectionInfo | null {
    try {
      if (!fs.existsSync(this.daemonConfigPath)) {
        return null;
      }
      const raw = fs.readFileSync(this.daemonConfigPath, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed?.port === "number") {
        return {
          port: parsed.port,
          token: typeof parsed?.token === "string" ? parsed.token : "",
          pid: parsed.pid,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Calls GET http://127.0.0.1:<port>/v1/health (or /health) with Authorization: Bearer <token>.
   * Returns true if health check succeeds, false if daemon is unreachable or unauthenticated.
   */
  async ping(): Promise<boolean> {
    const info = this.getConnectionInfo();
    if (!info) {
      return false;
    }

    const endpoints = [
      `http://127.0.0.1:${info.port}/v1/health`,
      `http://127.0.0.1:${info.port}/health`,
    ];

    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: info.token
            ? {
                Authorization: `Bearer ${info.token}`,
              }
            : {},
          signal: AbortSignal.timeout(2000),
        });

        if (!res.ok) {
          continue;
        }

        const data = (await res.json()) as any;
        if (data?.status === "ok") {
          return true;
        }
      } catch {
        // Try next endpoint if available
      }
    }

    return false;
  }

  /**
   * Dispatches a mission to POST http://127.0.0.1:<port>/v1/missions
   */
  async dispatchMission(
    goal: string,
    base: string = "main",
    workspaceId?: string
  ): Promise<{ ok: boolean; missionId?: string; error?: string }> {
    const info = this.getConnectionInfo();
    if (!info) {
      return { ok: false, error: "Aether Daemon is not running or connected." };
    }

    try {
      const url = `http://127.0.0.1:${info.port}/v1/missions`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${info.token}`,
        },
        body: JSON.stringify({
          goal,
          base,
          workspaceId,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        return { ok: false, error: errText || `HTTP ${res.status}` };
      }

      const data = (await res.json()) as any;
      return { ok: true, missionId: data.missionId };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }
}

