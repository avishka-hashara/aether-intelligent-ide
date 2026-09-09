import React, { useState } from "react";
import { spawnMission } from "../lib/api";
import { Rocket, Loader2, GitBranch, AlertCircle, CheckCircle } from "lucide-react";

export function SpawnMission() {
  const [goal, setGoal] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim()) return;

    setIsLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await spawnMission(goal.trim(), baseBranch.trim() || "main");
      setSuccessMsg(`Mission created: ${res.missionId}`);
      setGoal("");
    } catch (err: any) {
      setError(err.message || "Failed to spawn mission");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="bg-[#252526] border border-[#3e3e42] rounded-lg p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <Rocket className="w-5 h-5 text-[#58a6ff]" />
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[#cccccc]">
          Spawn Autonomous Mission
        </h2>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-[#8b949e] mb-1">
            Mission Goal & Objective
          </label>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. Implement full authentication flow with JWT and refresh tokens..."
            rows={3}
            required
            className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-3 py-2 text-xs text-[#cccccc] placeholder-[#6e7681] focus:outline-none focus:border-[#58a6ff] resize-none"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-[#8b949e] mb-1">
            Base Git Branch / Ref
          </label>
          <div className="relative">
            <GitBranch className="w-4 h-4 text-[#8b949e] absolute left-3 top-2.5" />
            <input
              type="text"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              placeholder="main"
              className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded pl-9 pr-3 py-2 text-xs text-[#cccccc] focus:outline-none focus:border-[#58a6ff]"
            />
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-[#f851491a] border border-[#f8514966] text-[#f85149] rounded p-2 text-xs">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {successMsg && (
          <div className="flex items-center gap-2 bg-[#3fb9501a] border border-[#3fb95066] text-[#3fb950] rounded p-2 text-xs">
            <CheckCircle className="w-4 h-4 shrink-0" />
            <span>{successMsg}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={isLoading || !goal.trim()}
          className="w-full flex items-center justify-center gap-2 bg-[#007acc] hover:bg-[#0062a3] disabled:opacity-50 text-white text-xs font-medium py-2 px-4 rounded transition-colors"
        >
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Scheduling Mission...</span>
            </>
          ) : (
            <>
              <Rocket className="w-4 h-4" />
              <span>Dispatch Mission</span>
            </>
          )}
        </button>
      </form>
    </div>
  );
}
