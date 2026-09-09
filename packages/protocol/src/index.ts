// Event envelope for WS messages and database rows
export interface MissionEvent<T = unknown> {
    schemaVersion: 1;
    seq: number;
    id: string;
    missionId: string;
    runId?: string;
    turnId?: string;
    ts: string;
    type: string;
    payload: T;
}

// Provider abstraction event union
export type ChatStreamEvent =
    | { type: "text_delta"; text: string }
    | { type: "reasoning_delta"; text: string }
    | { type: "tool_call_delta"; index: number; id?: string; name?: string; args?: string }
    | { type: "tool_call_complete"; id: string; name: string; args: string }
    | { type: "usage"; promptTokens: number; completionTokens: number }
    | { type: "done" }
    | { type: "error"; message: string };

// Internal tool result envelope
export interface ToolResult {
    ok: boolean;
    result?: unknown;
    error?: { code: string; message: string; recovery: string };
    truncated?: boolean;
    truncationHint?: string;
    durationMs?: number;
    warnings?: string[];
}

export * from "./artifacts.js";