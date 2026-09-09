import { useMissionStore } from "../store";

export interface SpawnMissionResponse {
  missionId: string;
  status: string;
  streamUrl?: string;
}

export interface CancelMissionResponse {
  missionId: string;
  status: string;
}

function getDaemonConfig() {
  const { daemonPort, daemonToken } = useMissionStore.getState();
  if (!daemonPort || !daemonToken) {
    throw new Error(
      "Daemon connection not initialized. Waiting for daemon configuration..."
    );
  }
  return {
    baseUrl: `http://127.0.0.1:${daemonPort}`,
    token: daemonToken,
  };
}

/**
 * Spawns a new mission on the Aether Agent Daemon.
 */
export async function spawnMission(
  goal: string,
  base: string = "main"
): Promise<SpawnMissionResponse> {
  const { baseUrl, token } = getDaemonConfig();

  const response = await fetch(`${baseUrl}/v1/missions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      workspaceId: "local",
      goal,
      base: {
        type: "branch",
        ref: base,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Failed to spawn mission: HTTP ${response.status} ${response.statusText} ${errorText}`
    );
  }

  return response.json() as Promise<SpawnMissionResponse>;
}

/**
 * Cancels a running or queued mission on the Aether Agent Daemon.
 */
export async function cancelMission(id: string): Promise<CancelMissionResponse> {
  const { baseUrl, token } = getDaemonConfig();

  const response = await fetch(`${baseUrl}/v1/missions/${id}/cancel`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Failed to cancel mission ${id}: HTTP ${response.status} ${response.statusText} ${errorText}`
    );
  }

  return response.json() as Promise<CancelMissionResponse>;
}
