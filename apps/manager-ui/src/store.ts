import { create } from "zustand";
import { MissionEvent } from "@aether/protocol";

export interface MissionItem {
  id: string;
  goal?: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  transcript: string[];
  metadata?: Record<string, any>;
}

export interface MissionStoreState {
  missions: Record<string, MissionItem>;
  dispatch: (event: MissionEvent) => void;
  reset: () => void;
}

/**
 * Event-sourced Zustand store projecting MissionEvent streams into UI state.
 */
export const useMissionStore = create<MissionStoreState>((set) => ({
  missions: {},

  dispatch: (event: MissionEvent) => {
    if (!event || !event.missionId) return;

    set((state) => {
      const missionId = event.missionId;
      const current = state.missions[missionId] || {
        id: missionId,
        status: "unknown",
        transcript: [],
      };

      const payload = (event.payload as any) || {};

      switch (event.type) {
        case "mission.created":
          return {
            missions: {
              ...state.missions,
              [missionId]: {
                id: missionId,
                goal: payload.goal ?? current.goal ?? "",
                status: payload.status ?? "created",
                createdAt: event.ts,
                updatedAt: event.ts,
                transcript: current.transcript ?? [],
                metadata: { ...current.metadata, ...payload },
              },
            },
          };

        case "mission.state_changed":
          return {
            missions: {
              ...state.missions,
              [missionId]: {
                ...current,
                status: payload.status ?? current.status,
                updatedAt: event.ts,
                metadata: { ...current.metadata, ...payload },
              },
            },
          };

        case "turn.text_delta":
          return {
            missions: {
              ...state.missions,
              [missionId]: {
                ...current,
                transcript: [...(current.transcript || []), payload.text || ""],
                updatedAt: event.ts,
              },
            },
          };

        case "run.failed":
        case "run.aborted":
        case "run.cancelled":
          return {
            missions: {
              ...state.missions,
              [missionId]: {
                ...current,
                status: "failed",
                updatedAt: event.ts,
              },
            },
          };

        case "run.finished":
        case "mission.completed":
          return {
            missions: {
              ...state.missions,
              [missionId]: {
                ...current,
                status: "completed",
                updatedAt: event.ts,
              },
            },
          };

        default:
          return state;
      }
    });
  },

  reset: () => set({ missions: {} }),
}));
