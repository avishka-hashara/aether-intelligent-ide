import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { MissionEvent } from "@aether/protocol";

export class WsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private port: number = 0;
  private token: string = "";
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isClosedExplicitly: boolean = false;

  /**
   * Connects to the daemon WebSocket stream endpoint.
   * Format: ws://127.0.0.1:<port>/v1/stream?token=${token}
   */
  connect(port: number, token: string): void {
    this.port = port;
    this.token = token;
    this.isClosedExplicitly = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    const url = `ws://127.0.0.1:${port}/v1/stream?token=${encodeURIComponent(token)}`;

    try {
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      this.ws.on("open", () => {
        // Subscribe to all missions on connection
        try {
          this.ws?.send(JSON.stringify({ type: "subscribe", missionIds: ["*"] }));
        } catch {}
        this.emit("connected");
      });

      this.ws.on("message", (data: WebSocket.RawData) => {
        try {
          const parsed = JSON.parse(data.toString()) as MissionEvent;
          if (parsed && typeof parsed.type === "string") {
            this.emit("event", parsed);
          }
        } catch {
          // Ignore non-JSON or invalid event payloads
        }
      });

      this.ws.on("close", () => {
        this.emit("disconnected");
        this.scheduleReconnect();
      });

      this.ws.on("error", (err: Error) => {
        this.emit("error", err);
        this.scheduleReconnect();
      });
    } catch (err: any) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect();
    }
  }

  /**
   * Schedules a 2-second reconnect backoff timer.
   */
  private scheduleReconnect(): void {
    if (this.isClosedExplicitly || this.reconnectTimer || !this.port) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isClosedExplicitly && this.port) {
        this.connect(this.port, this.token);
      }
    }, 2000);
  }

  /**
   * Disconnects the socket and clears any pending reconnect attempts.
   */
  disconnect(): void {
    this.isClosedExplicitly = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
}
