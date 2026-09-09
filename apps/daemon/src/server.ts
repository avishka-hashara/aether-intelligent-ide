import * as path from "node:path";
import * as crypto from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocketPlugin from "@fastify/websocket";
import type { WebSocket } from "ws";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type, Static } from "@sinclair/typebox";
import { eq } from "drizzle-orm";
import { MissionEvent } from "@aether/protocol";
import { ToolRegistry, toolSchemas } from "@aether/tools";
import { OpenRouterClient } from "@aether/providers";
import { BudgetTracker, runAgentLoop, MissionOrchestrator } from "@aether/agent-core";
import { ArtifactStore } from "@aether/artifacts";
import { initDB, workspaces, missions, missionEvents } from "@aether/cli";
import { createAuthPreHandler, generateToken } from "./auth.js";

const execAsync = promisify(exec);

const DEFAULT_SYSTEM_PROMPT = `You are Aether, an expert autonomous software engineer.
You are running within the Aether Agent Daemon on a local repository.
You have access to filesystem tools (fs.read, fs.list, fs.glob, fs.patch), search tools (search.grep), and terminal execution (terminal.exec).
Execute the user's goal with precision. Inspect the codebase, plan your steps, make minimal and safe modifications, and verify your results before completing the mission.`;

export const CreateMissionBody = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  goal: Type.String({ minLength: 1 }),
  model: Type.Optional(Type.String()),
  budget: Type.Optional(
    Type.Object({
      maxUsd: Type.Optional(Type.Number()),
      maxTokens: Type.Optional(Type.Integer()),
      maxWallClockMs: Type.Optional(Type.Integer()),
      maxToolCalls: Type.Optional(Type.Integer()),
    })
  ),
});

export type CreateMissionBodyType = Static<typeof CreateMissionBody>;

export const InlineCompletionBody = Type.Object({
  prefix: Type.String(),
  suffix: Type.String(),
  filepath: Type.String(),
  language: Type.String(),
  model: Type.Optional(Type.String()),
});

export type InlineCompletionBodyType = Static<typeof InlineCompletionBody>;

export const InlineEditBody = Type.Object({
  filepath: Type.String(),
  instruction: Type.String(),
  fileContent: Type.String(),
  selectionStartLine: Type.Number(),
  selectionEndLine: Type.Number(),
  model: Type.Optional(Type.String()),
});

export type InlineEditBodyType = Static<typeof InlineEditBody>;

export interface DaemonServerOptions {
  token?: string;
  logger?: boolean;
  orchestrator?: MissionOrchestrator;
  workspaceRoot?: string;
}

export interface DaemonServerInstance {
  server: FastifyInstance;
  token: string;
  broadcastEvent: (event: MissionEvent) => void;
  getOrchestrator?: (workspacePath: string) => MissionOrchestrator;
}

export function createDaemonServer(options: DaemonServerOptions = {}): DaemonServerInstance {
  const token = options.token ?? generateToken(32);
  const activeSockets = new Map<WebSocket, Set<string>>();
  const orchestrators = new Map<string, MissionOrchestrator>();
  const missionWorkspaceMap = new Map<
    string,
    { workspacePath: string; orchestrator: MissionOrchestrator }
  >();

  function getOrchestrator(workspacePath: string): MissionOrchestrator {
    if (options.orchestrator) {
      return options.orchestrator;
    }
    let orch = orchestrators.get(workspacePath);
    if (!orch) {
      const apiKey = process.env.OPENROUTER_API_KEY || "dummy-key";
      const provider = new OpenRouterClient(apiKey);
      orch = new MissionOrchestrator({
        workspaceRoot: workspacePath,
        provider,
        concurrency: 5,
        onEvent: (event) => {
          try {
            const { db } = initDB(workspacePath);
            db.insert(missionEvents)
              .values({
                id: event.id,
                missionId: event.missionId,
                runId: event.runId ?? null,
                turnId: event.turnId ?? null,
                type: event.type,
                payloadJson: JSON.stringify(event.payload),
                ts: event.ts,
              })
              .run();
          } catch {}
          broadcastEvent(event);
        },
        onMissionStatusChange: (missionId, status, details) => {
          try {
            const { db } = initDB(workspacePath);
            const now = new Date().toISOString();
            const updates: any = {
              status,
              updatedAt: now,
            };
            if (
              status === "completed" ||
              status === "failed" ||
              status === "cancelled"
            ) {
              updates.completedAt = now;
            }
            if (details?.spendUsd !== undefined) {
              updates.spendUsd = details.spendUsd;
            }
            if (details?.tokensUsed !== undefined) {
              updates.tokensUsed = details.tokensUsed;
            }
            db.update(missions)
              .set(updates)
              .where(eq(missions.id, missionId))
              .run();
          } catch {}
        },
      });
      orchestrators.set(workspacePath, orch);
    }
    return orch;
  }

  const server = Fastify({
    logger: options.logger ?? false,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Register CORS
  server.register(cors, { origin: "*" });

  function broadcastEvent(event: MissionEvent): void {
    const raw = JSON.stringify(event);
    for (const [socket, subscribedMissions] of activeSockets.entries()) {
      if (
        (subscribedMissions.has(event.missionId) || subscribedMissions.has("*")) &&
        socket.readyState === 1 /* WebSocket.OPEN */
      ) {
        try {
          socket.send(raw);
        } catch {
          // Socket send failed, ignore
        }
      }
    }
  }

  // Register WebSocket plugin
  server.register(websocketPlugin);

  // Register /v1 routes encapsulated with auth hook
  server.register(async (instance) => {
    const v1 = instance.withTypeProvider<TypeBoxTypeProvider>();
    v1.addHook("preHandler", createAuthPreHandler(token));

    // GET /v1/health
    v1.get("/health", async () => {
      return {
        status: "ok",
        version: "1.0.0",
        uptime: process.uptime(),
      };
    });

    // POST /v1/missions
    v1.post(
      "/missions",
      {
        schema: {
          body: CreateMissionBody,
        },
      },
      async (request, reply) => {
        const { workspaceId, goal, model, budget: reqBudget } = request.body;
          const workspacePath = path.resolve(workspaceId);

          // Initialize SQLite DB at <workspacePath>/.aether/aether.db
          const { db, sqlite } = initDB(workspacePath);

          const now = new Date().toISOString();
          const missionId = `m_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

          // Ensure workspace record exists
          try {
            db.insert(workspaces)
              .values({
                id: workspacePath,
                rootPath: workspacePath,
                name: path.basename(workspacePath),
                createdAt: now,
              })
              .onConflictDoNothing()
              .run();
          } catch {
            // Ignored if table already has workspace
          }

          const budget = {
            maxUsd: reqBudget?.maxUsd ?? 2.0,
            maxTokens: reqBudget?.maxTokens ?? 500000,
            maxWallClockMs: reqBudget?.maxWallClockMs ?? 1800000,
            maxToolCalls: reqBudget?.maxToolCalls ?? 100,
          };

          // Create mission record in SQLite
          db.insert(missions)
            .values({
              id: missionId,
              workspaceId: workspacePath,
              goal,
              surface: "daemon",
              executionMode: "autonomous",
              status: "queued",
              isolation: "inplace",
              policyProfile: "trusted",
              budgetJson: JSON.stringify(budget),
              spendUsd: 0,
              tokensUsed: 0,
              blackboardJson: "{}",
              createdAt: now,
              updatedAt: now,
            })
            .run();

          // Schedule mission through MissionOrchestrator.dispatch
          const orchestrator = getOrchestrator(workspacePath);
          missionWorkspaceMap.set(missionId, { workspacePath, orchestrator });

          orchestrator
            .dispatch(
              missionId,
              goal,
              "HEAD",
              budget,
              model ?? "anthropic/claude-3.5-sonnet"
            )
            .catch((err) => {
              server.log.error(
                err,
                `Mission ${missionId} orchestrator dispatch error`
              );
            });

          if (sqlite) {
            try {
              sqlite.close();
            } catch {}
          }

          // Determine server port
          const addr = server.server.address();
          const port = typeof addr === "object" && addr ? addr.port : 0;

          return reply.status(202).send({
            missionId,
            status: "queued",
            streamUrl: `ws://127.0.0.1:${port}/v1/stream`,
          });
        }
    );

    // POST /v1/missions/:id/cancel
    v1.post<{ Params: { id: string } }>(
      "/missions/:id/cancel",
      async (request, reply) => {
        const missionId = request.params.id;
        const entry = missionWorkspaceMap.get(missionId);
        const orchestrator = entry?.orchestrator ?? options.orchestrator;

        if (orchestrator) {
          orchestrator.cancel(missionId);
        }

        if (entry?.workspacePath) {
          try {
            const { db } = initDB(entry.workspacePath);
            db.update(missions)
              .set({
                status: "cancelled",
                updatedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
              })
              .where(eq(missions.id, missionId))
              .run();
          } catch {}
        }

        broadcastEvent({
          schemaVersion: 1,
          seq: Date.now(),
          id: crypto.randomUUID(),
          missionId,
          ts: new Date().toISOString(),
          type: "run.cancelled",
          payload: { missionId, status: "cancelled" },
        });

        return reply.status(200).send({
          missionId,
          status: "cancelled",
        });
      }
    );

    // POST /v1/missions/:id/apply
    v1.post<{ Params: { id: string } }>(
      "/missions/:id/apply",
      async (request, reply) => {
        const missionId = request.params.id;
        const entry = missionWorkspaceMap.get(missionId);
        const workspacePath = entry?.workspacePath;

        if (!workspacePath) {
          return reply.status(404).send({
            error: "mission_not_found",
            message: `Mission ${missionId} not found in active workspace map`,
          });
        }

        const branchName = `aether/${missionId}`;
        try {
          await execAsync(`git merge ${branchName}`, { cwd: workspacePath });
        } catch (err: any) {
          return reply.status(500).send({
            error: "merge_failed",
            message: `Failed to merge branch ${branchName}: ${err?.message || String(err)}`,
          });
        }

        const orchestrator = entry.orchestrator ?? options.orchestrator;
        if (orchestrator) {
          await orchestrator.cleanupMission(missionId);
        }

        try {
          const { db } = initDB(workspacePath);
          db.update(missions)
            .set({
              status: "applied",
              updatedAt: new Date().toISOString(),
            })
            .where(eq(missions.id, missionId))
            .run();
        } catch {}

        return reply.status(200).send({
          missionId,
          status: "applied",
        });
      }
    );

    // GET /v1/missions/:id/artifacts
    v1.get<{ Params: { id: string } }>(
      "/missions/:id/artifacts",
      async (request, reply) => {
        const missionId = request.params.id;
        const workspacePath =
          missionWorkspaceMap.get(missionId)?.workspacePath ||
          options.workspaceRoot ||
          path.resolve(".");

        try {
          const { sqlite } = initDB(workspacePath);
          const rows = sqlite
            .prepare(
              `SELECT a.* FROM artifacts a
               INNER JOIN (
                 SELECT id, MAX(version) AS max_version
                 FROM artifacts
                 WHERE mission_id = ?
                 GROUP BY id
               ) latest ON a.id = latest.id AND a.version = latest.max_version
               WHERE a.mission_id = ?
               ORDER BY a.created_at ASC`
            )
            .all(missionId, missionId) as any[];

          const artifactsList = rows.map((r: any) => ({
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

          return reply.status(200).send({
            missionId,
            artifacts: artifactsList,
          });
        } catch (err: any) {
          return reply.status(500).send({
            error: "artifacts_fetch_failed",
            message: err?.message || String(err),
          });
        }
      }
    );

    // POST /v1/artifacts/:id/comments
    v1.post<{
      Params: { id: string };
      Body: { body: string; anchor?: any };
    }>(
      "/artifacts/:id/comments",
      async (request, reply) => {
        const artifactId = request.params.id;
        const { body: commentBody, anchor } = request.body || {};

        if (!commentBody || typeof commentBody !== "string" || !commentBody.trim()) {
          return reply.status(400).send({
            error: "invalid_body",
            message: "Comment body is required and cannot be empty.",
          });
        }

        const workspacePath = options.workspaceRoot || path.resolve(".");
        try {
          const { sqlite } = initDB(workspacePath);
          const art = sqlite
            .prepare(
              "SELECT mission_id, MAX(version) as version FROM artifacts WHERE id = ?"
            )
            .get(artifactId) as any;

          const missionId = art?.mission_id || "default";
          const artifactVersion = art?.version || 1;

          const store = new ArtifactStore(sqlite);
          const comment = await store.addComment({
            artifactId,
            artifactVersion,
            author: "user",
            body: commentBody.trim(),
            anchor,
            missionId,
          });

          broadcastEvent({
            schemaVersion: 1,
            seq: Date.now(),
            id: crypto.randomUUID(),
            missionId,
            ts: new Date().toISOString(),
            type: "artifact.comment_created",
            payload: comment,
          });

          return reply.status(201).send(comment);
        } catch (err: any) {
          return reply.status(500).send({
            error: "comment_creation_failed",
            message: err?.message || String(err),
          });
        }
      }
    );

    // POST /v1/missions/:id/approvals
    v1.post<{
      Params: { id: string };
      Body: {
        approvalId: string;
        decision: "approve" | "reject" | "modify";
        comment?: string;
      };
    }>(
      "/missions/:id/approvals",
      async (request, reply) => {
        const missionId = request.params.id;
        const { approvalId, decision, comment } = request.body || {};

        if (!approvalId || !["approve", "reject", "modify"].includes(decision)) {
          return reply.status(400).send({
            error: "invalid_approval_request",
            message: "approvalId and valid decision ('approve' | 'reject' | 'modify') are required.",
          });
        }

        const workspacePath =
          missionWorkspaceMap.get(missionId)?.workspacePath ||
          options.workspaceRoot ||
          path.resolve(".");

        try {
          const { sqlite } = initDB(workspacePath);
          const now = new Date().toISOString();

          sqlite
            .prepare(
              `UPDATE approvals
               SET decision = ?, decided_by = 'user', comment = ?, decided_at = ?
               WHERE id = ? AND mission_id = ?`
            )
            .run(decision, comment || null, now, approvalId, missionId);

          const steeringBody = `[APPROVAL DECISION] Gate ${approvalId} was ${decision.toUpperCase()}.${
            comment ? ` Feedback: ${comment}` : ""
          }`;

          sqlite
            .prepare(
              `INSERT INTO steering_inbox (id, mission_id, source, body, consumed_at, created_at)
               VALUES (?, ?, 'user', ?, NULL, ?)`
            )
            .run(`steer-appr-${crypto.randomUUID()}`, missionId, steeringBody, now);

          const nextStatus = decision === "reject" ? "failed" : "executing";

          sqlite
            .prepare("UPDATE missions SET status = ?, updated_at = ? WHERE id = ?")
            .run(nextStatus, now, missionId);

          broadcastEvent({
            schemaVersion: 1,
            seq: Date.now(),
            id: crypto.randomUUID(),
            missionId,
            ts: now,
            type: "approval.resolved",
            payload: { approvalId, decision, comment, nextStatus },
          });

          broadcastEvent({
            schemaVersion: 1,
            seq: Date.now(),
            id: crypto.randomUUID(),
            missionId,
            ts: now,
            type: "mission.state_changed",
            payload: { missionId, status: nextStatus },
          });

          return reply.status(200).send({
            missionId,
            approvalId,
            decision,
            status: nextStatus,
          });
        } catch (err: any) {
          return reply.status(500).send({
            error: "approval_resolution_failed",
            message: err?.message || String(err),
          });
        }
      }
    );

    // POST /v1/inline/completion
    v1.post(
      "/inline/completion",
      {
        schema: {
          body: InlineCompletionBody,
        },
      },
      async (request, reply) => {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
          return reply.status(500).send({
            error: "missing_api_key",
            message: "OPENROUTER_API_KEY environment variable is missing",
          });
        }

        const { prefix, suffix, model: reqModel } = request.body;
        const model = reqModel || "google/gemini-2.5-flash";

        const abortController = new AbortController();
        const onAborted = () => {
          abortController.abort();
        };
        request.raw.on("aborted", onAborted);
        request.raw.on("close", () => {
          if (request.raw.destroyed) {
            abortController.abort();
          }
        });

        const provider = new OpenRouterClient(apiKey);
        const systemPrompt =
          "You are an inline code completion engine. Output ONLY the exact code that belongs between the PREFIX and SUFFIX. Do not include markdown formatting or explanations.";
        const userPrompt = `PREFIX:\n${prefix}\n\nSUFFIX:\n${suffix}`;

        let completion = "";

        try {
          const stream = provider.chat(
            {
              model,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
              ],
              temperature: 0.1,
              max_tokens: 256,
            },
            abortController.signal
          );

          for await (const event of stream) {
            if (abortController.signal.aborted) {
              break;
            }
            if (event.type === "text_delta") {
              completion += event.text;
            } else if (event.type === "error") {
              return reply.status(500).send({
                error: "provider_error",
                message: event.message,
              });
            }
          }
        } catch (err: any) {
          if (abortController.signal.aborted) {
            return reply.status(499).send({ error: "client_aborted" });
          }
          return reply.status(500).send({
            error: "completion_error",
            message: err?.message || String(err),
          });
        } finally {
          request.raw.off("aborted", onAborted);
        }

        if (abortController.signal.aborted) {
          return reply.status(499).send({ error: "client_aborted" });
        }

        return { completion };
      }
    );

    // POST /v1/inline/edit
    v1.post(
      "/inline/edit",
      {
        schema: {
          body: InlineEditBody,
        },
      },
      async (request, reply) => {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
          return reply.status(500).send({
            error: "missing_api_key",
            message: "OPENROUTER_API_KEY environment variable is missing",
          });
        }

        const {
          filepath,
          instruction,
          fileContent,
          selectionStartLine,
          selectionEndLine,
          model: reqModel,
        } = request.body;
        const model = reqModel || "anthropic/claude-3.5-sonnet";

        const abortController = new AbortController();
        const onAborted = () => {
          abortController.abort();
        };
        request.raw.on("aborted", onAborted);
        request.raw.on("close", () => {
          if (request.raw.destroyed) {
            abortController.abort();
          }
        });

        const provider = new OpenRouterClient(apiKey);
        const systemPrompt =
          "You are an expert coder. Apply the user's instruction to the provided file content. Focus specifically on the lines indicated by the user's selection. Output ONLY a valid unified diff (a/ and b/ format) containing the changes. Do not use markdown blocks or explanations.";
        const userPrompt = `File: ${filepath}\nTarget Selection Lines: ${selectionStartLine} to ${selectionEndLine}\nInstruction: ${instruction}\n\nFile Content:\n${fileContent}`;

        let diffText = "";

        try {
          const stream = provider.chat(
            {
              model,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
              ],
              temperature: 0.1,
            },
            abortController.signal
          );

          for await (const event of stream) {
            if (abortController.signal.aborted) {
              break;
            }
            if (event.type === "text_delta") {
              diffText += event.text;
            } else if (event.type === "error") {
              return reply.status(500).send({
                error: "provider_error",
                message: event.message,
              });
            }
          }
        } catch (err: any) {
          if (abortController.signal.aborted) {
            return reply.status(499).send({ error: "client_aborted" });
          }
          return reply.status(500).send({
            error: "inline_edit_error",
            message: err?.message || String(err),
          });
        } finally {
          request.raw.off("aborted", onAborted);
        }

        if (abortController.signal.aborted) {
          return reply.status(499).send({ error: "client_aborted" });
        }

        let cleanDiff = diffText.trim();
        if (cleanDiff.startsWith("```diff")) {
          cleanDiff = cleanDiff.slice(7);
        } else if (cleanDiff.startsWith("```")) {
          cleanDiff = cleanDiff.slice(3);
        }
        if (cleanDiff.endsWith("```")) {
          cleanDiff = cleanDiff.slice(0, -3);
        }
        cleanDiff = cleanDiff.trim();

        return { diff: cleanDiff };
      }
    );

    // WS /v1/stream
    v1.get(
      "/stream",
      { websocket: true },
      (socket: WebSocket, _req) => {
        const subscriptions = new Set<string>();
        activeSockets.set(socket, subscriptions);

        socket.on("message", (raw: Buffer | string) => {
          try {
            const data = JSON.parse(raw.toString());
            if (data.type === "subscribe" && Array.isArray(data.missionIds)) {
              for (const mid of data.missionIds) {
                if (typeof mid === "string") {
                  subscriptions.add(mid);
                }
              }
            } else if (data.type === "unsubscribe" && Array.isArray(data.missionIds)) {
              for (const mid of data.missionIds) {
                subscriptions.delete(mid);
              }
            }
          } catch {
            // Ignore invalid JSON messages from clients
          }
        });

        socket.on("close", () => {
          activeSockets.delete(socket);
        });

        socket.on("error", () => {
          activeSockets.delete(socket);
        });
      }
    );
  }, { prefix: "/v1" });

  return {
    server,
    token,
    broadcastEvent,
  };
}

interface BackgroundMissionArgs {
  missionId: string;
  workspacePath: string;
  goal: string;
  model: string;
  budget: {
    maxUsd: number;
    maxTokens: number;
    maxWallClockMs: number;
    maxToolCalls: number;
  };
  db: any;
  sqlite?: any;
  broadcastEvent: (event: MissionEvent) => void;
}

async function startBackgroundMission({
  missionId,
  workspacePath,
  goal,
  model,
  budget,
  db,
  sqlite,
  broadcastEvent,
}: BackgroundMissionArgs): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    const errorEvent: MissionEvent = {
      schemaVersion: 1,
      seq: 1,
      id: crypto.randomUUID(),
      missionId,
      ts: new Date().toISOString(),
      type: "run.failed",
      payload: {
        error: "missing_api_key",
        message: "OPENROUTER_API_KEY environment variable is missing",
      },
    };

    try {
      db.insert(missionEvents)
        .values({
          id: errorEvent.id,
          missionId: errorEvent.missionId,
          type: errorEvent.type,
          payloadJson: JSON.stringify(errorEvent.payload),
          ts: errorEvent.ts,
        })
        .run();

      db.update(missions)
        .set({
          status: "failed",
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(missions.id, missionId))
        .run();
    } catch {}

    broadcastEvent(errorEvent);
    if (sqlite) {
      try { sqlite.close(); } catch {}
    }
    return;
  }

  const toolsRegistry = new ToolRegistry(workspacePath);
  const provider = new OpenRouterClient(apiKey);
  const tracker = new BudgetTracker(budget);

  // Transition status from queued to executing
  db.update(missions)
    .set({
      status: "executing",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(missions.id, missionId))
    .run();

  let finalStatus: "completed" | "failed" = "completed";

  try {
    const loop = runAgentLoop({
      provider,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      initialUserPrompt: goal,
      toolSchemas,
      tracker,
      toolsRegistry,
      model,
      missionId,
    });

    for await (const event of loop) {
      // Append to SQLite mission_events
      try {
        db.insert(missionEvents)
          .values({
            id: event.id,
            missionId: event.missionId,
            runId: event.runId ?? null,
            turnId: event.turnId ?? null,
            type: event.type,
            payloadJson: JSON.stringify(event.payload),
            ts: event.ts,
          })
          .run();
      } catch (dbErr) {
        console.error(`[Daemon DB Error] Failed to persist event ${event.id}:`, dbErr);
      }

      // Broadcast to subscribed WebSocket clients
      broadcastEvent(event);

      if (event.type === "run.failed" || event.type === "run.aborted") {
        finalStatus = "failed";
      }
    }
  } catch (loopErr: any) {
    finalStatus = "failed";
    console.error(`[Daemon] Agent loop error for mission ${missionId}:`, loopErr);
  } finally {
    const completedAt = new Date().toISOString();
    try {
      db.update(missions)
        .set({
          status: finalStatus,
          spendUsd: tracker.currentUsd,
          tokensUsed: tracker.currentTokens,
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(missions.id, missionId))
        .run();
    } catch (dbErr) {
      console.error(`[Daemon DB Error] Failed to update mission ${missionId}:`, dbErr);
    } finally {
      if (sqlite) {
        try { sqlite.close(); } catch {}
      }
    }
  }
}
