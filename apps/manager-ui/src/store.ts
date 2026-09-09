import { create } from "zustand";
import { MissionEvent } from "@aether/protocol";

export interface MissionItem {
  id: string;
  goal?: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  transcript: string[];
  events: MissionEvent[];
  metadata?: Record<string, any>;
}

export interface MissionStoreState {
  daemonPort: number | null;
  daemonToken: string | null;
  selectedMissionId: string | null;
  missions: Record<string, MissionItem>;
  init: (port: number, token: string) => void;
  selectMission: (id: string | null) => void;
  dispatch: (event: MissionEvent) => void;
  reset: () => void;
}

/**
 * Event-sourced Zustand store projecting MissionEvent streams into UI state.
 */
export const useMissionStore = create<MissionStoreState>((set) => ({
  daemonPort: null,
  daemonToken: null,
  selectedMissionId: null,
  missions: {},

  init: (port: number, token: string) => {
    set({ daemonPort: port, daemonToken: token });
  },

  selectMission: (id: string | null) => {
    set({ selectedMissionId: id });
  },

  dispatch: (event: MissionEvent) => {
    if (!event || !event.missionId) return;

    set((state) => {
      const missionId = event.missionId;
      const current = state.missions[missionId] || {
        id: missionId,
        status: "unknown",
        transcript: [],
        events: [],
      };

      const payload = (event.payload as any) || {};
      const updatedEvents = [...(current.events || []), event];

      let newStatus = current.status;
      let newGoal = current.goal;
      let newTranscript = current.transcript || [];

      switch (event.type) {
        case "mission.created":
          newGoal = payload.goal ?? current.goal ?? "";
          newStatus = payload.status ?? "created";
          break;

        case "mission.state_changed":
          newStatus = payload.status ?? current.status;
          break;

        case "turn.text_delta":
          newTranscript = [...newTranscript, payload.text || ""];
          break;

        case "run.failed":
        case "run.aborted":
          newStatus = "failed";
          break;

        case "run.cancelled":
          newStatus = "cancelled";
          break;

        case "run.finished":
        case "mission.completed":
          newStatus = "completed";
          break;

        default:
          break;
      }

      const updatedMission: MissionItem = {
        ...current,
        id: missionId,
        goal: newGoal,
        status: newStatus,
        createdAt: current.createdAt || event.ts,
        updatedAt: event.ts,
        transcript: newTranscript,
        events: updatedEvents,
        metadata: { ...current.metadata, ...payload },
      };

      return {
        missions: {
          ...state.missions,
          [missionId]: updatedMission,
        },
      };
    });
  },

  reset: () =>
    set({
      missions: {},
      selectedMissionId: null,
      daemonPort: null,
      daemonToken: null,
    }),
}));
