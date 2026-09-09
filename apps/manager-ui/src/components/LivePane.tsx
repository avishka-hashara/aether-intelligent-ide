import React, { useEffect, useRef } from "react";
import { useMissionStore } from "../store";
import { Terminal, Wrench, FileCode, CheckCircle, AlertOctagon, Info } from "lucide-react";

export function LivePane() {
  const selectedMissionId = useMissionStore((state) => state.selectedMissionId);
  const missions = useMissionStore((state) => state.missions);
  const mission = selectedMissionId ? missions[selectedMissionId] : null;

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [mission?.events, mission?.transcript]);

  if (!selectedMissionId || !mission) {
    return (
      <div className="bg-[#252526] border border-[#3e3e42] rounded-lg p-5 flex flex-col h-full items-center justify-center text-center text-[#8b949e] shadow-sm">
        <Terminal className="w-10 h-10 mb-2 opacity-40 text-[#58a6ff]" />
        <p className="text-xs font-medium text-[#cccccc]">No Mission Selected</p>
        <p className="text-[11px] mt-1 max-w-xs">
          Select a mission card from the board to view its live execution feed and event stream.
        </p>
      </div>
    );
  }

  const events = mission.events || [];

  return (
    <div className="bg-[#252526] border border-[#3e3e42] rounded-lg p-5 flex flex-col h-full shadow-sm">
      <div className="flex items-center justify-between pb-3 mb-3 border-b border-[#3e3e42]">
        <div className="flex items-center gap-2 min-w-0">
          <Terminal className="w-5 h-5 text-[#58a6ff] shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-[#cccccc]">Live Event Stream</span>
              <span className="font-mono text-[10px] text-[#58a6ff] bg-[#58a6ff1a] px-1.5 py-0.5 rounded">
                {mission.id}
              </span>
            </div>
            <p className="text-[11px] text-[#8b949e] truncate max-w-md">
              {mission.goal}
            </p>
          </div>
        </div>
        <div className="text-[10px] text-[#8b949e] shrink-0">
          {events.length} events
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto space-y-2 pr-1 font-mono text-xs max-h-[calc(100vh-280px)]"
      >
        {events.length === 0 && (
          <div className="flex items-center gap-2 p-3 bg-[#1e1e1e] border border-[#3e3e42] rounded text-[#8b949e] text-xs">
            <Info className="w-4 h-4 text-[#58a6ff]" />
            <span>Waiting for mission events...</span>
          </div>
        )}

        {events.map((event, idx) => {
          const payload = (event.payload as any) || {};

          // 1. Text Delta (Agent reasoning / assistant output)
          if (event.type === "turn.text_delta") {
            return (
              <div
                key={event.id || idx}
                className="p-2.5 bg-[#1e1e1e] border border-[#3e3e42] rounded text-[#cccccc] font-sans text-xs leading-relaxed whitespace-pre-wrap"
              >
                {payload.text || ""}
              </div>
            );
          }

          // 2. Tool Started or Turn Step Started (Highlighted technical block)
          if (
            event.type === "tool.started" ||
            event.type === "turn.step_started" ||
            payload.toolCall ||
            payload.tool
          ) {
            const toolName =
              payload.tool || payload.toolCall?.name || payload.name || "tool_call";
            const toolInput =
              payload.input || payload.toolCall?.arguments || payload.args || {};

            return (
              <div
                key={event.id || idx}
                className="p-2.5 bg-[#161b22] border border-[#30363d] rounded-md font-mono text-[11px]"
              >
                <div className="flex items-center gap-1.5 text-[#e3b341] font-semibold mb-1">
                  <Wrench className="w-3.5 h-3.5" />
                  <span>TOOL CALL:</span>
                  <span className="text-[#79c0ff]">{toolName}</span>
                </div>
                {toolInput && Object.keys(toolInput).length > 0 && (
                  <pre className="bg-[#0d1117] p-2 rounded text-[#8b949e] overflow-x-auto text-[10px] mt-1">
                    {JSON.stringify(toolInput, null, 2)}
                  </pre>
                )}
              </div>
            );
          }

          // 3. Tool Finished (Result block)
          if (event.type === "tool.finished" || payload.toolResult) {
            return (
              <div
                key={event.id || idx}
                className="p-2.5 bg-[#161b22] border border-[#30363d] rounded-md font-mono text-[11px]"
              >
                <div className="flex items-center gap-1.5 text-[#56d364] font-semibold mb-1">
                  <FileCode className="w-3.5 h-3.5" />
                  <span>TOOL OUTPUT</span>
                </div>
                <pre className="bg-[#0d1117] p-2 rounded text-[#8b949e] overflow-x-auto text-[10px] mt-1 max-h-40">
                  {typeof payload.result === "string"
                    ? payload.result
                    : JSON.stringify(payload.result ?? payload, null, 2)}
                </pre>
              </div>
            );
          }

          // 4. Mission Completed
          if (event.type === "run.completed" || event.type === "mission.completed") {
            return (
              <div
                key={event.id || idx}
                className="p-3 bg-[#2386361a] border border-[#23863666] rounded-md flex items-center gap-2 text-[#3fb950] font-sans text-xs"
              >
                <CheckCircle className="w-4 h-4 shrink-0" />
                <span>Mission completed successfully.</span>
              </div>
            );
          }

          // 5. Turn Error / Run Error
          if (event.type === "turn.error" || event.type === "run.error") {
            const errorMsg =
              payload.message ||
              payload.error ||
              (typeof payload === "string" ? payload : "") ||
              (event as any).error ||
              (event as any).data?.error ||
              (event as any).message ||
              "An execution error occurred.";

            const displayText =
              typeof errorMsg === "object"
                ? JSON.stringify(errorMsg, null, 2)
                : String(errorMsg);

            return (
              <div
                key={event.id || idx}
                className="text-red-500 bg-red-950/30 p-2 rounded border border-red-900/50 flex items-start gap-2 text-xs font-mono"
              >
                <AlertOctagon className="w-4 h-4 shrink-0 mt-0.5 text-red-500" />
                <div className="flex-1 overflow-x-auto whitespace-pre-wrap break-words">
                  <span className="font-semibold uppercase text-[10px] tracking-wide block mb-0.5 text-red-400">
                    {event.type}
                  </span>
                  <span>{displayText}</span>
                </div>
              </div>
            );
          }

          // 6. Mission Failed / Cancelled
          if (event.type === "run.failed" || event.type === "run.cancelled") {
            return (
              <div
                key={event.id || idx}
                className="p-3 bg-[#da36331a] border border-[#da363366] rounded-md flex items-center gap-2 text-[#f85149] font-sans text-xs"
              >
                <AlertOctagon className="w-4 h-4 shrink-0" />
                <span>
                  {event.type === "run.cancelled"
                    ? "Mission cancelled by user."
                    : payload.error || "Mission execution encountered a failure."}
                </span>
              </div>
            );
          }

          // Default event badge
          return (
            <div
              key={event.id || idx}
              className="p-1.5 bg-[#1e1e1e] border border-[#3e3e42] rounded text-[10px] text-[#8b949e] flex items-center justify-between"
            >
              <span className="font-semibold text-[#8b949e]">{event.type}</span>
              <span>{event.ts ? new Date(event.ts).toLocaleTimeString() : ""}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
