export interface Artifact {
  id: string;
  missionId: string;
  runId?: string;
  type: string;
  version: number;
  title: string;
  status: "draft" | "published" | "superseded";
  requiresApproval: boolean;
  body: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactComment {
  id: string;
  artifactId: string;
  artifactVersion: number;
  anchor?: any;
  author: string;
  body: string;
  status: "open" | "resolved";
  createdAt: string;
}

export interface SteeringMessage {
  id: string;
  missionId: string;
  source: string;
  body: string;
  consumedAt?: string;
  createdAt: string;
}
