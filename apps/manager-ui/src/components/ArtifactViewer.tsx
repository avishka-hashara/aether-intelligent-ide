import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getArtifacts, postArtifactComment } from "../lib/api";
import {
  FileText,
  Send,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Code,
  Layers,
  Sparkles,
} from "lucide-react";

interface ArtifactViewerProps {
  missionId: string;
}

export function ArtifactViewer({ missionId }: ArtifactViewerProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  const [feedbackErr, setFeedbackErr] = useState<string | null>(null);

  const {
    data: artifacts = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["artifacts", missionId],
    queryFn: () => getArtifacts(missionId),
    refetchInterval: 4000,
    enabled: Boolean(missionId),
  });

  const activeArtifact = artifacts[selectedIdx] || artifacts[0];

  const handleSendFeedback = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feedback.trim() || !activeArtifact) return;

    setIsSending(true);
    setFeedbackMsg(null);
    setFeedbackErr(null);

    try {
      await postArtifactComment(activeArtifact.id, feedback.trim());
      setFeedbackMsg("Feedback dispatched into agent steering inbox!");
      setFeedback("");
      refetch();
    } catch (err: any) {
      setFeedbackErr(err?.message || "Failed to submit steering feedback");
    } finally {
      setIsSending(false);
    }
  };

  if (isLoading && artifacts.length === 0) {
    return (
      <div className="bg-[#252526] border border-[#3e3e42] rounded-lg p-5 flex flex-col items-center justify-center min-h-[220px] text-[#8b949e]">
        <Loader2 className="w-6 h-6 animate-spin text-[#58a6ff] mb-2" />
        <span className="text-xs">Loading mission deliverables...</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="bg-[#252526] border border-[#3e3e42] rounded-lg p-4 text-xs text-[#f85149] flex items-center gap-2">
        <AlertCircle className="w-4 h-4 shrink-0" />
        <span>Failed to load artifacts for mission {missionId}.</span>
      </div>
    );
  }

  if (artifacts.length === 0) {
    return (
      <div className="bg-[#252526] border border-[#3e3e42] rounded-lg p-5 flex flex-col items-center justify-center min-h-[200px] text-center text-[#8b949e]">
        <FileText className="w-8 h-8 opacity-30 text-[#58a6ff] mb-2" />
        <p className="text-xs font-medium text-[#cccccc]">No Artifacts Published</p>
        <p className="text-[11px] mt-1 max-w-xs">
          Deliverables (plans, architecture diagrams, diffs) published by the agent will appear here.
        </p>
      </div>
    );
  }

  const renderArtifactBody = (body: any, type: string) => {
    if (type === "implementation_plan" && typeof body === "object" && body !== null) {
      return (
        <div className="space-y-3 font-sans text-xs">
          {body.summary && (
            <div>
              <span className="font-semibold text-[#58a6ff] uppercase tracking-wider text-[10px] block mb-1">
                Plan Summary
              </span>
              <p className="text-[#cccccc] bg-[#1e1e1e] p-2.5 rounded border border-[#3e3e42] leading-relaxed">
                {body.summary}
              </p>
            </div>
          )}

          {body.approach && (
            <div>
              <span className="font-semibold text-[#58a6ff] uppercase tracking-wider text-[10px] block mb-1">
                Technical Approach
              </span>
              <p className="text-[#cccccc] bg-[#1e1e1e] p-2.5 rounded border border-[#3e3e42] leading-relaxed">
                {body.approach}
              </p>
            </div>
          )}

          {Array.isArray(body.steps) && (
            <div>
              <span className="font-semibold text-[#58a6ff] uppercase tracking-wider text-[10px] block mb-1">
                Execution Steps ({body.steps.length})
              </span>
              <div className="space-y-1.5">
                {body.steps.map((step: any, sIdx: number) => (
                  <div
                    key={sIdx}
                    className="flex items-start gap-2 bg-[#1e1e1e] p-2 rounded border border-[#3e3e42] text-[11px]"
                  >
                    <span className="font-mono text-[#58a6ff] font-bold shrink-0">
                      {sIdx + 1}.
                    </span>
                    <span className="text-[#cccccc]">
                      {typeof step === "string" ? step : step.title || JSON.stringify(step)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    if (typeof body === "string") {
      return (
        <pre className="bg-[#1e1e1e] p-3 rounded border border-[#3e3e42] font-mono text-[11px] text-[#cccccc] whitespace-pre-wrap overflow-x-auto leading-relaxed">
          {body}
        </pre>
      );
    }

    return (
      <pre className="bg-[#1e1e1e] p-3 rounded border border-[#3e3e42] font-mono text-[10px] text-[#8b949e] overflow-x-auto">
        {JSON.stringify(body, null, 2)}
      </pre>
    );
  };

  return (
    <div className="bg-[#252526] border border-[#3e3e42] rounded-lg p-4 flex flex-col shadow-sm">
      <div className="flex items-center justify-between pb-3 mb-3 border-b border-[#3e3e42]">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-[#58a6ff]" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[#cccccc]">
            Artifacts &amp; Deliverables ({artifacts.length})
          </h3>
        </div>
        <span className="text-[10px] text-[#8b949e]">
          v{activeArtifact?.version ?? 1} &bull; {activeArtifact?.status}
        </span>
      </div>

      {/* Tab Switcher */}
      <div className="flex gap-1.5 overflow-x-auto pb-2 mb-3 border-b border-[#3e3e42]">
        {artifacts.map((art, idx) => {
          const isCurrent = idx === selectedIdx;
          return (
            <button
              key={art.id + art.version}
              onClick={() => setSelectedIdx(idx)}
              className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs transition-colors whitespace-nowrap ${
                isCurrent
                  ? "bg-[#0969da] text-white font-medium"
                  : "bg-[#1e1e1e] text-[#8b949e] hover:text-[#cccccc] hover:bg-[#323234]"
              }`}
            >
              <Code className="w-3 h-3" />
              <span>{art.title || art.id}</span>
              <span className="text-[10px] opacity-75">v{art.version}</span>
            </button>
          );
        })}
      </div>

      {/* Artifact Body Display */}
      {activeArtifact && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-[#f0f6fc]">
              {activeArtifact.title}
            </h4>
            <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-[#3e3e42] text-[#cccccc]">
              {activeArtifact.type}
            </span>
          </div>
          {renderArtifactBody(activeArtifact.body, activeArtifact.type)}
        </div>
      )}

      {/* Human Steering Feedback Form */}
      <form onSubmit={handleSendFeedback} className="pt-3 border-t border-[#3e3e42] space-y-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-[#8b949e]">
          <Sparkles className="w-3.5 h-3.5 text-[#58a6ff]" />
          <span>Steer Agent / Leave Feedback on Deliverable</span>
        </div>

        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="e.g. Include integration tests for edge cases, or adjust step 2..."
          rows={2}
          className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-3 py-1.5 text-xs text-[#cccccc] placeholder-[#6e7681] focus:outline-none focus:border-[#58a6ff] resize-none"
        />

        {feedbackMsg && (
          <div className="flex items-center gap-1.5 text-[#3fb950] text-[11px]">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>{feedbackMsg}</span>
          </div>
        )}

        {feedbackErr && (
          <div className="flex items-center gap-1.5 text-[#f85149] text-[11px]">
            <AlertCircle className="w-3.5 h-3.5" />
            <span>{feedbackErr}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={isSending || !feedback.trim() || !activeArtifact}
          className="flex items-center justify-center gap-1.5 bg-[#238636] hover:bg-[#2ea043] disabled:opacity-50 text-white text-[11px] font-medium py-1.5 px-3 rounded transition-colors"
        >
          {isSending ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Sending Feedback...</span>
            </>
          ) : (
            <>
              <Send className="w-3 h-3" />
              <span>Inject Steering Feedback</span>
            </>
          )}
        </button>
      </form>
    </div>
  );
}
