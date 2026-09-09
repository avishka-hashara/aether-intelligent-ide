import React, { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMissionStore } from "./store";
import { postMessage } from "./lib/vscode";
import { SpawnMission } from "./components/SpawnMission";
import { MissionBoard } from "./components/MissionBoard";
import { LivePane } from "./components/LivePane";
import { Activity, ShieldCheck, Zap } from "lucide-react";

const queryClient = new QueryClient();

export const App: React.FC = () => {
  const dispatch = useMissionStore((state) => state.dispatch);
  const init = useMissionStore((state) => state.init);
  const daemonPort = useMissionStore((state) => state.daemonPort);
  const missions = useMissionStore((state) => state.missions);

  const [daemonConnected, setDaemonConnected] = useState(false);

  useEffect(() => {
    // Notify host that manager webview is ready to receive configuration
    postMessage({ type: "ready" });

    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data) return;

      // Handle daemon initialization payload from extension
      if (data.type === "init" && data.port && data.token) {
        init(data.port, data.token);
        setDaemonConnected(true);
      }

      // Handle streamed mission events
      if (data.type === "event" && data.event) {
        dispatch(data.event);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [dispatch, init]);

  const activeCount = Object.values(missions).filter(
    (m) => m.status === "executing" || m.status === "queued"
  ).length;

  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-[#1e1e1e] text-[#cccccc] p-5 flex flex-col font-sans box-border selection:bg-[#264f78]">
        {/* Top Header */}
        <header className="flex flex-wrap items-center justify-between gap-4 pb-4 mb-5 border-b border-[#3e3e42]">
          <div>
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-[#58a6ff]" />
              <h1 className="text-xl font-bold bg-gradient-to-r from-[#58a6ff] to-[#bc8cff] bg-clip-text text-transparent tracking-tight">
                Aether Mission Control
              </h1>
            </div>
            <p className="text-xs text-[#8b949e] mt-1">
              Real-time multi-agent orchestration, event streaming &amp; workspace lifecycle
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* Daemon Status Indicator */}
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#252526] border border-[#3e3e42] text-[11px]">
              <ShieldCheck
                className={`w-3.5 h-3.5 ${
                  daemonConnected ? "text-[#3fb950]" : "text-[#d29922] animate-pulse"
                }`}
              />
              <span className="text-[#8b949e]">Daemon:</span>
              <span className={daemonConnected ? "text-[#3fb950] font-medium" : "text-[#d29922]"}>
                {daemonConnected ? `Online (: ${daemonPort})` : "Connecting..."}
              </span>
            </div>

            {/* Active Missions Badge */}
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#58a6ff1a] border border-[#58a6ff33] text-[11px] text-[#58a6ff]">
              <Activity className="w-3.5 h-3.5" />
              <span>{activeCount} Active</span>
            </div>
          </div>
        </header>

        {/* 3-Pane Layout: Spawn Mission | Mission Board | Live Event Pane */}
        <main className="grid grid-cols-1 lg:grid-cols-12 gap-5 flex-1 items-start">
          {/* Left Column: Mission Spawn & Configuration */}
          <div className="lg:col-span-3 flex flex-col gap-5">
            <SpawnMission />
          </div>

          {/* Center Column: Mission Board Grid */}
          <div className="lg:col-span-4 flex flex-col h-full">
            <MissionBoard />
          </div>

          {/* Right Column: Live Event Stream Feed */}
          <div className="lg:col-span-5 flex flex-col h-full">
            <LivePane />
          </div>
        </main>
      </div>
    </QueryClientProvider>
  );
};
