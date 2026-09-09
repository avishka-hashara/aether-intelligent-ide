import React, { useState } from "react";
import { useMissionStore, MissionItem } from "../store";
import { cancelMission } from "../lib/api";
import {
  Clock,
  PlayCircle,
  CheckCircle2,
  XCircle,
  StopCircle,
  AlertTriangle,
  Radio,
  Layers,
} from "lucide-react";

export function MissionBoard() {
  const missions = useMissionStore((state) => state.missions);
  const selectedMissionId = useMissionStore((state) => state.selectedMissionId);
  const selectMission = useMissionStore((state) => state.selectMission);

  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const missionList: MissionItem[] = Object.values(missions).sort((a, b) => {
    const timeA = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const timeB = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return timeB - timeA;
  });

  const handleCancel = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setCancellingId(id);
    try {
      await cancelMission(id);
    } catch (err) {
      console.error(`Failed to cancel mission ${id}:`, err);
    } finally {
      setCancellingId(null);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status.toLowerCase()) {
      case "executing":
        return (
          <span className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-medium bg-[#0969da22] text-[#58a6ff] border border-[#58a6ff44]">
            <Radio className="w-3 h-3 animate-pulse text-[#58a6ff]" />
            EXECUTING
          </span>
        );
      case "queued":
        return (
          <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-[#d2992222] text-[#d29922] border border-[#d2992244]">
            <Clock className="w-3 h-3" />
            QUEUED
          </span>
        );
      case "completed":
        return (
          <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-[#3fb95022] text-[#3fb950] border border-[#3fb95044]">
            <CheckCircle2 className="w-3 h-3" />
            COMPLETED
          </span>
        );
      case "failed":
        return (
          <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-[#f8514922] text-[#f85149] border border-[#f8514944]">
            <XCircle className="w-3 h-3" />
            FAILED
          </span>
        );
      case "cancelled":
        return (
          <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-[#8b949e22] text-[#8b949e] border border-[#8b949e44]">
            <StopCircle className="w-3 h-3" />
            CANCELLED
          </span>
        );
      default:
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[#3e3e42] text-[#cccccc]">
            {status.toUpperCase()}
          </span>
        );
    }
  };

  return (
    <div className="bg-[#252526] border border-[#3e3e42] rounded-lg p-5 flex flex-col h-full shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Layers className="w-5 h-5 text-[#58a6ff]" />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[#cccccc]">
            Active Missions ({missionList.length})
          </h2>
        </div>
      </div>

      {missionList.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 border border-dashed border-[#3e3e42] rounded-lg text-center text-[#8b949e]">
          <PlayCircle className="w-10 h-10 mb-2 opacity-40 text-[#58a6ff]" />
          <p className="text-xs font-medium text-[#cccccc]">No missions registered</p>
          <p className="text-[11px] mt-1">
            Dispatch a new mission using the form on the left or via CLI.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5 overflow-y-auto pr-1 flex-1 max-h-[calc(100vh-280px)]">
          {missionList.map((m) => {
            const isSelected = selectedMissionId === m.id;
            const canCancel = m.status === "executing" || m.status === "queued";

            return (
              <div
                key={m.id}
                onClick={() => selectMission(m.id)}
                className={`p-3.5 rounded-lg border transition-all cursor-pointer ${
                  isSelected
                    ? "bg-[#1f242c] border-[#58a6ff] shadow-sm"
                    : "bg-[#1e1e1e] border-[#3e3e42] hover:border-[#6e7681]"
                }`}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="font-mono text-[11px] text-[#58a6ff] truncate">
                    {m.id}
                  </div>
                  {getStatusBadge(m.status)}
                </div>

                <p className="text-xs text-[#cccccc] font-medium line-clamp-2 mb-3">
                  {m.goal || "No goal specified"}
                </p>

                <div className="flex items-center justify-between pt-2 border-t border-[#3e3e42] text-[10px] text-[#8b949e]">
                  <div>
                    {m.updatedAt
                      ? new Date(m.updatedAt).toLocaleTimeString()
                      : m.createdAt
                      ? new Date(m.createdAt).toLocaleTimeString()
                      : ""}
                  </div>

                  <div className="flex items-center gap-2">
                    {canCancel && (
                      <button
                        onClick={(e) => handleCancel(e, m.id)}
                        disabled={cancellingId === m.id}
                        className="px-2 py-1 bg-[#da363322] hover:bg-[#da363344] text-[#f85149] border border-[#f8514944] rounded text-[10px] font-medium transition-colors"
                      >
                        {cancellingId === m.id ? "Cancelling..." : "Cancel"}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
