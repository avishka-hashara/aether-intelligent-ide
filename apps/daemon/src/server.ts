import * as path from "node:path";
import * as crypto from "node:crypto";
import Fastify, { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import type { WebSocket } from "ws";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type, Static } from "@sinclair/typebox";
import { eq } from "drizzle-orm";
import { MissionEvent } from "@aether/protocol";
import { ToolRegistry, toolSchemas } from "@aether/tools";
import { OpenRouterClient } from "@aether/providers";
import { BudgetTracker, runAgentLoop } from "@aether/agent-core";
import { initDB, workspaces, missions, missionEvents } from "@aether/cli";
import { createAuthPreHandler, generateToken } from "./auth.js";

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

export interface DaemonServerOptions {
  token?: string;
  logger?: boolean;
}

export interface DaemonServerInstance {
  server: FastifyInstance;
  token: string;
  broadcastEvent: (event: MissionEvent) => void;
}

export function createDaemonServer(options: DaemonServerOptions = {}): DaemonServerInstance {
  const token = options.token ?? generateToken(32);
  const activeSockets = new Map<WebSocket, Set<string>>();

  const server = Fastify({
    logger: options.logger ?? false,
  }).withTypeProvider<TypeBoxTypeProvider>();

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

        // Start agent loop asynchronously in the background (do not await)
        startBackgroundMission({
          missionId,
          workspacePath,
          goal,
          model: model ?? "anthropic/claude-3.5-sonnet",
          budget,
          db,
          sqlite,
          broadcastEvent,
        }).catch((err) => {
          server.log.error(err, `Background mission ${missionId} failed`);
        });

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
