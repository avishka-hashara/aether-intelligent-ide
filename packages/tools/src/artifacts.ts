import { ToolResult } from "@aether/protocol";

export interface ArtifactPublishInput {
  id: string;
  type: string;
  title: string;
  body: unknown;
}

export interface HumanAskInput {
  question: string;
}

export interface ArtifactToolContext {
  artifactStore?: any;
  missionId?: string;
  onHumanAsk?: (question: string) => Promise<string> | void;
}

/**
 * artifact.publish tool:
 * Publishes an artifact via the mission's ArtifactStore if available,
 * or returns the published artifact envelope.
 */
export async function publishArtifact(
  input: ArtifactPublishInput,
  context?: ArtifactToolContext
): Promise<ToolResult> {
  const startTime = Date.now();

  if (!input || !input.id || !input.type || !input.title) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: "Missing required fields: id, type, title, body",
        recovery: "Ensure id, type, title, and body are provided in the payload.",
      },
      durationMs: Date.now() - startTime,
    };
  }

  let published: any = {
    id: input.id,
    type: input.type,
    title: input.title,
    body: input.body,
    version: 1,
    status: "published",
    createdAt: new Date().toISOString(),
  };

  if (context?.artifactStore) {
    try {
      published = await context.artifactStore.publish({
        id: input.id,
        missionId: context.missionId || "default",
        type: input.type,
        title: input.title,
        body: input.body,
        status: "published",
        requiresApproval: false,
      });
    } catch (err: any) {
      return {
        ok: false,
        error: {
          code: "publish_error",
          message: err?.message || String(err),
          recovery: "Check artifact payload and try again.",
        },
        durationMs: Date.now() - startTime,
      };
    }
  }

  return {
    ok: true,
    result: {
      message: `Artifact '${input.title}' (${input.id}) published successfully.`,
      artifact: published,
    },
    durationMs: Date.now() - startTime,
  };
}

/**
 * human.ask tool:
 * Suspends the agent turn until the human responds or provides input.
 */
export async function humanAsk(
  input: HumanAskInput,
  context?: ArtifactToolContext
): Promise<ToolResult> {
  const startTime = Date.now();

  if (!input || !input.question) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: "Missing required field: question",
        recovery: "Provide the question or clarification you want to ask the user.",
      },
      durationMs: Date.now() - startTime,
    };
  }

  if (context?.onHumanAsk) {
    context.onHumanAsk(input.question);
  }

  return {
    ok: true,
    result: {
      status: "awaiting_input",
      question: input.question,
      suspended: true,
      message: `Question dispatched to human. Agent turn suspended awaiting user response: "${input.question}"`,
    },
    durationMs: Date.now() - startTime,
  };
}
