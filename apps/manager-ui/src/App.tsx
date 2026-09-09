import React, { useEffect } from "react";
import { useMissionStore } from "./store";
import { postMessage } from "./lib/vscode";

export const App: React.FC = () => {
  const missions = useMissionStore((state) => state.missions);
  const dispatch = useMissionStore((state) => state.dispatch);

  useEffect(() => {
    // Notify host that manager webview is ready
    postMessage({ type: "ready" });

    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data && data.type === "event" && data.event) {
        dispatch(data.event);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [dispatch]);

  const missionList = Object.values(missions);

  const getStatusBadgeColor = (status: string) => {
    switch (status.toLowerCase()) {
      case "executing":
      case "in_progress":
        return { bg: "#0d3a58", border: "#1f6feb", text: "#58a6ff" };
      case "completed":
      case "applied":
        return { bg: "#133824", border: "#238636", text: "#3fb950" };
      case "failed":
        return { bg: "#441a1d", border: "#da3633", text: "#f85149" };
      case "cancelled":
        return { bg: "#363b42", border: "#6e7681", text: "#8b949e" };
      case "queued":
      default:
        return { bg: "#3a2d04", border: "#9e6a03", text: "#d29922" };
    }
  };

  return (
    <div
      style={{
        fontFamily: "var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif)",
        backgroundColor: "var(--vscode-editor-background, #0d1117)",
        color: "var(--vscode-editor-foreground, #c9d1d9)",
        minHeight: "100vh",
        padding: "24px 32px",
        boxSizing: "border-box",
      }}
    >
      <header
        style={{
          borderBottom: "1px solid var(--vscode-widget-border, #30363d)",
          paddingBottom: "16px",
          marginBottom: "24px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <h1
            style={{
              margin: 0,
              fontSize: "24px",
              fontWeight: 600,
              letterSpacing: "-0.5px",
              background: "linear-gradient(90deg, #58a6ff, #bc8cff)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            Aether Mission Control
          </h1>
          <p
            style={{
              margin: "4px 0 0 0",
              color: "var(--vscode-descriptionForeground, #8b949e)",
              fontSize: "13px",
            }}
          >
            Parallel Autonomous Agents &amp; Mission Event Stream
          </p>
        </div>
        <div
          style={{
            fontSize: "12px",
            padding: "6px 12px",
            borderRadius: "6px",
            background: "rgba(88, 166, 255, 0.1)",
            border: "1px solid rgba(88, 166, 255, 0.2)",
            color: "#58a6ff",
            fontWeight: 500,
          }}
        >
          {missionList.length} Active {missionList.length === 1 ? "Mission" : "Missions"}
        </div>
      </header>

      {missionList.length === 0 ? (
        <div
          style={{
            padding: "48px",
            textAlign: "center",
            border: "1px dashed var(--vscode-widget-border, #30363d)",
            borderRadius: "8px",
            background: "rgba(22, 27, 34, 0.5)",
          }}
        >
          <div style={{ fontSize: "28px", marginBottom: "12px" }}>🛸</div>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "16px", color: "#f0f6fc" }}>
            No Active Missions
          </h3>
          <p
            style={{
              margin: 0,
              fontSize: "13px",
              color: "var(--vscode-descriptionForeground, #8b949e)",
            }}
          >
            Missions launched via CLI or Daemon will appear here in real time.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {missionList.map((m) => {
            const badge = getStatusBadgeColor(m.status);
            const transcriptSnippet =
              m.transcript && m.transcript.length > 0
                ? m.transcript.slice(-3).join("")
                : null;

            return (
              <div
                key={m.id}
                style={{
                  background: "var(--vscode-sideBar-background, #161b22)",
                  border: "1px solid var(--vscode-widget-border, #30363d)",
                  borderRadius: "8px",
                  padding: "16px 20px",
                  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "8px",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "monospace",
                      fontWeight: 600,
                      fontSize: "14px",
                      color: "#f0f6fc",
                    }}
                  >
                    {m.id}
                  </span>
                  <span
                    style={{
                      fontSize: "11px",
                      textTransform: "uppercase",
                      letterSpacing: "0.5px",
                      fontWeight: 600,
                      padding: "3px 8px",
                      borderRadius: "12px",
                      backgroundColor: badge.bg,
                      border: `1px solid ${badge.border}`,
                      color: badge.text,
                    }}
                  >
                    {m.status}
                  </span>
                </div>

                {m.goal && (
                  <div
                    style={{
                      fontSize: "13px",
                      color: "#c9d1d9",
                      marginBottom: "12px",
                      lineHeight: "1.4",
                    }}
                  >
                    {m.goal}
                  </div>
                )}

                {transcriptSnippet && (
                  <div
                    style={{
                      marginTop: "8px",
                      padding: "8px 12px",
                      borderRadius: "4px",
                      background: "rgba(0, 0, 0, 0.25)",
                      fontFamily: "monospace",
                      fontSize: "12px",
                      color: "#8b949e",
                      whiteSpace: "pre-wrap",
                      maxHeight: "80px",
                      overflowY: "auto",
                    }}
                  >
                    {transcriptSnippet}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
