import { describe, it, expect, beforeEach } from "vitest";
import { useMissionStore } from "./store";
import { MissionEvent } from "@aether/protocol";

describe("useMissionStore (@aether/manager-ui)", () => {
  beforeEach(() => {
    useMissionStore.getState().reset();
  });

  it("should initialize with empty missions", () => {
    expect(useMissionStore.getState().missions).toEqual({});
  });

  it("should add mission on mission.created event", () => {
    const event: MissionEvent = {
      schemaVersion: 1,
      seq: 1,
      id: "ev-1",
      missionId: "m_test_100",
      ts: "2026-09-09T12:00:00.000Z",
      type: "mission.created",
      payload: {
        goal: "Refactor database migrations",
        status: "queued",
      },
    };

    useMissionStore.getState().dispatch(event);

    const missions = useMissionStore.getState().missions;
    expect(missions["m_test_100"]).toBeDefined();
    expect(missions["m_test_100"].goal).toBe("Refactor database migrations");
    expect(missions["m_test_100"].status).toBe("queued");
    expect(missions["m_test_100"].transcript).toEqual([]);
  });

  it("should update status on mission.state_changed event", () => {
    const createEvent: MissionEvent = {
      schemaVersion: 1,
      seq: 1,
      id: "ev-1",
      missionId: "m_test_200",
      ts: "2026-09-09T12:00:00.000Z",
      type: "mission.created",
      payload: { status: "queued" },
    };
    useMissionStore.getState().dispatch(createEvent);

    const stateEvent: MissionEvent = {
      schemaVersion: 1,
      seq: 2,
      id: "ev-2",
      missionId: "m_test_200",
      ts: "2026-09-09T12:00:05.000Z",
      type: "mission.state_changed",
      payload: { status: "executing" },
    };
    useMissionStore.getState().dispatch(stateEvent);

    const mission = useMissionStore.getState().missions["m_test_200"];
    expect(mission.status).toBe("executing");
    expect(mission.updatedAt).toBe("2026-09-09T12:00:05.000Z");
  });

  it("should append text delta on turn.text_delta event", () => {
    const delta1: MissionEvent = {
      schemaVersion: 1,
      seq: 1,
      id: "ev-1",
      missionId: "m_test_300",
      ts: "2026-09-09T12:01:00.000Z",
      type: "turn.text_delta",
      payload: { text: "Thinking about " },
    };
    const delta2: MissionEvent = {
      schemaVersion: 1,
      seq: 2,
      id: "ev-2",
      missionId: "m_test_300",
      ts: "2026-09-09T12:01:01.000Z",
      type: "turn.text_delta",
      payload: { text: "solution..." },
    };

    useMissionStore.getState().dispatch(delta1);
    useMissionStore.getState().dispatch(delta2);

    const mission = useMissionStore.getState().missions["m_test_300"];
    expect(mission.transcript).toEqual(["Thinking about ", "solution..."]);
  });

  it("should update to completed on run.finished event", () => {
    const event: MissionEvent = {
      schemaVersion: 1,
      seq: 1,
      id: "ev-1",
      missionId: "m_test_400",
      ts: "2026-09-09T12:02:00.000Z",
      type: "run.finished",
      payload: { content: "All done!" },
    };

    useMissionStore.getState().dispatch(event);
    expect(useMissionStore.getState().missions["m_test_400"].status).toBe("completed");
  });
});
