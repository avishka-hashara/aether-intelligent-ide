import * as crypto from "node:crypto";
import { Artifact, ArtifactComment, SteeringMessage } from "@aether/protocol";

export class ArtifactStore {
  private sqlite: any;

  constructor(db: any) {
    if (typeof db?.prepare === "function") {
      this.sqlite = db;
    } else if (db?.$client && typeof db.$client.prepare === "function") {
      this.sqlite = db.$client;
    } else if (db?.session?.client && typeof db.session.client.prepare === "function") {
      this.sqlite = db.session.client;
    } else {
      this.sqlite = db;
    }
  }

  /**
   * Publishes an artifact:
   * If an artifact with the same id and missionId already exists,
   * bumps the version and marks previous versions as 'superseded'.
   * Otherwise inserts version 1 (or provided version).
   */
  async publish(
    artifact: Omit<Artifact, "version" | "createdAt" | "updatedAt"> & { version?: number }
  ): Promise<Artifact> {
    const now = new Date().toISOString();

    const existing = this.sqlite
      .prepare(
        "SELECT MAX(version) as maxVersion FROM artifacts WHERE id = ? AND mission_id = ?"
      )
      .get(artifact.id, artifact.missionId) as { maxVersion: number | null } | undefined;

    let targetVersion = 1;
    if (existing && existing.maxVersion != null) {
      targetVersion = existing.maxVersion + 1;
      this.sqlite
        .prepare(
          "UPDATE artifacts SET status = 'superseded', updated_at = ? WHERE id = ? AND mission_id = ?"
        )
        .run(now, artifact.id, artifact.missionId);
    } else if (artifact.version) {
      targetVersion = artifact.version;
    }

    const published: Artifact = {
      id: artifact.id,
      missionId: artifact.missionId,
      runId: artifact.runId,
      type: artifact.type,
      version: targetVersion,
      title: artifact.title,
      status: artifact.status || "published",
      requiresApproval: !!artifact.requiresApproval,
      body: artifact.body,
      createdAt: now,
      updatedAt: now,
    };

    this.sqlite
      .prepare(
        `INSERT INTO artifacts (
          id, mission_id, run_id, type, version, title, status, requires_approval, body_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        published.id,
        published.missionId,
        published.runId || null,
        published.type,
        published.version,
        published.title,
        published.status,
        published.requiresApproval ? 1 : 0,
        JSON.stringify(published.body ?? {}),
        published.createdAt,
        published.updatedAt
      );

    return published;
  }

  /**
   * Adds a comment to an artifact and simultaneously pushes a record into
   * steering_inbox so the agent loop knows the user provided feedback.
   */
  async addComment(
    comment: Omit<ArtifactComment, "id" | "createdAt" | "status"> & {
      id?: string;
      status?: "open" | "resolved";
      missionId?: string;
    }
  ): Promise<ArtifactComment> {
    const commentId = comment.id || `comment-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const newComment: ArtifactComment = {
      id: commentId,
      artifactId: comment.artifactId,
      artifactVersion: comment.artifactVersion,
      anchor: comment.anchor,
      author: comment.author,
      body: comment.body,
      status: comment.status || "open",
      createdAt: now,
    };

    this.sqlite
      .prepare(
        `INSERT INTO artifact_comments (
          id, artifact_id, artifact_version, anchor_json, author, body, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        newComment.id,
        newComment.artifactId,
        newComment.artifactVersion,
        newComment.anchor ? JSON.stringify(newComment.anchor) : null,
        newComment.author,
        newComment.body,
        newComment.status,
        newComment.createdAt
      );

    let missionId = comment.missionId;
    if (!missionId) {
      const artRow = this.sqlite
        .prepare("SELECT mission_id FROM artifacts WHERE id = ? LIMIT 1")
        .get(comment.artifactId) as { mission_id: string } | undefined;
      missionId = artRow?.mission_id;
    }

    if (missionId) {
      const steeringId = `steer-${crypto.randomUUID()}`;
      this.sqlite
        .prepare(
          `INSERT INTO steering_inbox (
            id, mission_id, source, body, consumed_at, created_at
          ) VALUES (?, ?, ?, ?, NULL, ?)`
        )
        .run(steeringId, missionId, comment.author, comment.body, now);
    }

    return newComment;
  }

  /**
   * Retrieves all unconsumed steering messages for a mission and marks them as consumed.
   */
  async consumeSteeringInbox(missionId: string): Promise<SteeringMessage[]> {
    const now = new Date().toISOString();

    const rows = this.sqlite
      .prepare(
        `SELECT id, mission_id, source, body, consumed_at, created_at
         FROM steering_inbox
         WHERE mission_id = ? AND consumed_at IS NULL
         ORDER BY created_at ASC`
      )
      .all(missionId) as Array<{
        id: string;
        mission_id: string;
        source: string;
        body: string;
        consumed_at: string | null;
        created_at: string;
      }>;

    if (rows.length === 0) {
      return [];
    }

    this.sqlite
      .prepare(
        `UPDATE steering_inbox
         SET consumed_at = ?
         WHERE mission_id = ? AND consumed_at IS NULL`
      )
      .run(now, missionId);

    return rows.map((r) => ({
      id: r.id,
      missionId: r.mission_id,
      source: r.source,
      body: r.body,
      consumedAt: now,
      createdAt: r.created_at,
    }));
  }

  /**
   * Helper to retrieve all versions of an artifact.
   */
  async getArtifactVersions(artifactId: string): Promise<Artifact[]> {
    const rows = this.sqlite
      .prepare("SELECT * FROM artifacts WHERE id = ? ORDER BY version ASC")
      .all(artifactId) as any[];

    return rows.map((r) => ({
      id: r.id,
      missionId: r.mission_id,
      runId: r.run_id || undefined,
      type: r.type,
      version: r.version,
      title: r.title,
      status: r.status,
      requiresApproval: Boolean(r.requires_approval),
      body: JSON.parse(r.body_json || "null"),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Helper to retrieve latest version of an artifact.
   */
  async getLatestArtifact(artifactId: string): Promise<Artifact | null> {
    const row = this.sqlite
      .prepare(
        "SELECT * FROM artifacts WHERE id = ? ORDER BY version DESC LIMIT 1"
      )
      .get(artifactId) as any;

    if (!row) return null;

    return {
      id: row.id,
      missionId: row.mission_id,
      runId: row.run_id || undefined,
      type: row.type,
      version: row.version,
      title: row.title,
      status: row.status,
      requiresApproval: Boolean(row.requires_approval),
      body: JSON.parse(row.body_json || "null"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
