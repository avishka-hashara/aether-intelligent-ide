import React, { useState } from "react";
import { useMissionStore, MissionItem } from "../store";
import { resolveApproval } from "../lib/api";
import {
  Inbox,
  HelpCircle,
  Check,
  X,
  Edit3,
  Loader2,
  AlertTriangle,
  Send,
} from "lucide-react";

export function AgentInbox() {
  const missions = useMissionStore((state) => state.missions);
  const selectMission = useMissionStore((state) => state.selectMission);

  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [modifyComments, setModifyComments] = useState<Record<string, string>>({});
  const [showModifyInput, setShowModifyInput] = useState<Record<string, boolean>>({});

  // Detect missions requiring human input or approval
  const waitingMissions: MissionItem[] = Object.values(missions).filter((m) => {
    const s = m.status.toLowerCase();
    return (
      s === "awaiting_input" ||
      s === "awaiting_plan_approval" ||
      s === "awaiting_approval" ||
      m.metadata?.status === "awaiting_input" ||
      m.metadata?.approvalRequired
    );
  });

  if (waitingMissions.length === 0) {
    return null;
  }

  const handleResolve = async (
    missionId: string,
    approvalId: string,
    decision: "approve" | "reject" | "modify"
  ) => {
    setResolvingId(missionId);
    const comment = modifyComments[missionId] || "";

    try {
      await resolveApproval(missionId, approvalId, decision, comment);
      // Clean up input state
      setModifyComments((prev) => ({ ...prev, [missionId]: "" }));
      setShowModifyInput((prev) => ({ ...prev, [missionId]: false }));
    } catch (err) {
      console.error("Failed to resolve approval:", err);
    } finally {
      setResolvingId(null);
    }
  };

  const extractQuestionOrSummary = (m: MissionItem) => {
    if (m.metadata?.question) return m.metadata.question;
    // Check last event in mission.events
    if (m.events && m.events.length > 0) {
      const lastEvent = m.events[m.events.length - 1];
      const p = (lastEvent.payload as any) || {};
      if (p.question) return p.question;
      if (p.summary) return p.summary;
      if (p.message) return p.message;
    }
    return m.goal || "Agent is awaiting your review and approval before proceeding.";
  };

  return (
    <div className="bg-[#2d2215] border border-[#d2992266] rounded-lg p-4 mb-4 shadow-md">
      <div className="flex items-center gap-2 mb-3">
        <Inbox className="w-5 h-5 text-[#e3b341] animate-bounce" />
        <h3 className="text-xs font-bold uppercase tracking-wider text-[#f0883e]">
          Human Attention Required ({waitingMissions.length})
        </h3>
      </div>

      <div className="space-y-3">
        {waitingMissions.map((m) => {
          const approvalId = m.metadata?.approvalId || `appr-${m.id}`;
          const isResolving = resolvingId === m.id;
          const questionText = extractQuestionOrSummary(m);
          const isModifying = showModifyInput[m.id];

          return (
            <div
              key={m.id}
              onClick={() => selectMission(m.id)}
              className="bg-[#1e1e1e] border border-[#d2992244] rounded-lg p-3 text-xs cursor-pointer hover:border-[#e3b341] transition-colors"
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="font-mono text-[11px] text-[#58a6ff]">
                  {m.id}
                </span>
                <span className="flex items-center gap-1 text-[10px] font-bold text-[#e3b341] bg-[#e3b3411a] px-2 py-0.5 rounded border border-[#e3b34133]">
                  <HelpCircle className="w-3 h-3" />
                  {m.status.toUpperCase().replace(/_/g, " ")}
                </span>
              </div>

              <p className="text-[#cccccc] mb-3 leading-relaxed font-medium">
                {questionText}
              </p>

              {isModifying && (
                <div className="mb-3 space-y-1.5">
                  <textarea
                    value={modifyComments[m.id] || ""}
                    onChange={(e) =>
                      setModifyComments((prev) => ({
                        ...prev,
                        [m.id]: e.target.value,
                      }))
                    }
                    placeholder="Specify requested adjustments or modifications..."
                    rows={2}
                    className="w-full bg-[#161b22] border border-[#d2992266] rounded p-2 text-xs text-[#cccccc] placeholder-[#6e7681] focus:outline-none focus:border-[#e3b341] resize-none"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowModifyInput((prev) => ({ ...prev, [m.id]: false }));
                      }}
                      className="px-2 py-1 text-[10px] text-[#8b949e] hover:text-[#cccccc]"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleResolve(m.id, approvalId, "modify");
                      }}
                      disabled={isResolving}
                      className="flex items-center gap-1 px-3 py-1 bg-[#d29922] hover:bg-[#bb8009] text-black font-semibold rounded text-[10px]"
                    >
                      <Send className="w-3 h-3" />
                      Submit Modification
                    </button>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 pt-2 border-t border-[#3e3e42]">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleResolve(m.id, approvalId, "approve");
                  }}
                  disabled={isResolving}
                  className="flex items-center gap-1 bg-[#238636] hover:bg-[#2ea043] disabled:opacity-50 text-white font-medium px-3 py-1.5 rounded text-[11px] transition-colors"
                >
                  {isResolving ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Check className="w-3.5 h-3.5" />
                  )}
                  <span>Approve</span>
                </button>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowModifyInput((prev) => ({
                      ...prev,
                      [m.id]: !prev[m.id],
                    }));
                  }}
                  disabled={isResolving}
                  className="flex items-center gap-1 bg-[#d2992222] hover:bg-[#d2992244] border border-[#d2992266] text-[#e3b341] font-medium px-3 py-1.5 rounded text-[11px] transition-colors"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>Modify</span>
                </button>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleResolve(m.id, approvalId, "reject");
                  }}
                  disabled={isResolving}
                  className="flex items-center gap-1 bg-[#da363322] hover:bg-[#da363344] border border-[#da363366] text-[#f85149] font-medium px-3 py-1.5 rounded text-[11px] transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>Reject</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
