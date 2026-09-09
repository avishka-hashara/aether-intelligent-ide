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

/**
 * Fetches all latest artifacts for a mission.
 */
export async function getArtifacts(missionId: string): Promise<any[]> {
  const { baseUrl, token } = getDaemonConfig();

  const response = await fetch(`${baseUrl}/v1/missions/${missionId}/artifacts`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Failed to fetch artifacts for mission ${missionId}: HTTP ${response.status} ${errorText}`
    );
  }

  const data = await response.json();
  return data.artifacts || [];
}

/**
 * Posts feedback/comment on an artifact, populating the steering inbox.
 */
export async function postArtifactComment(
  artifactId: string,
  body: string,
  anchor?: any
): Promise<any> {
  const { baseUrl, token } = getDaemonConfig();

  const response = await fetch(`${baseUrl}/v1/artifacts/${artifactId}/comments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ body, anchor }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Failed to post artifact comment: HTTP ${response.status} ${errorText}`
    );
  }

  return response.json();
}

/**
 * Resolves an approval gate for a mission ('approve' | 'reject' | 'modify').
 */
export async function resolveApproval(
  missionId: string,
  approvalId: string,
  decision: "approve" | "reject" | "modify",
  comment?: string
): Promise<{ missionId: string; approvalId: string; decision: string; status: string }> {
  const { baseUrl, token } = getDaemonConfig();

  const response = await fetch(`${baseUrl}/v1/missions/${missionId}/approvals`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ approvalId, decision, comment }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Failed to resolve approval: HTTP ${response.status} ${errorText}`
    );
  }

  return response.json();
}

