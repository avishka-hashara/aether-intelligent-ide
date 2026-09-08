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
      if (typeof parsed?.port === "number" && typeof parsed?.token === "string") {
        return {
          port: parsed.port,
          token: parsed.token,
          pid: parsed.pid,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Calls GET http://127.0.0.1:<port>/v1/health with Authorization: Bearer <token>.
   * Returns true if health check succeeds, false if daemon is unreachable or unauthenticated.
   */
  async ping(): Promise<boolean> {
    const info = this.getConnectionInfo();
    if (!info) {
      return false;
    }

    try {
      const url = `http://127.0.0.1:${info.port}/v1/health`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${info.token}`,
        },
        signal: AbortSignal.timeout(2000),
      });

      if (!res.ok) {
        return false;
      }

      const data = (await res.json()) as any;
      return data?.status === "ok";
    } catch {
      return false;
    }
  }
}
