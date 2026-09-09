import { ToolResult } from "@aether/protocol";

export interface TaskUpdateInput {
  taskId: string;
  title?: string;
  status?: string;
  filesTouched?: string[];
}

export interface BlackboardSetInput {
  key: string;
  value: unknown;
}

export interface BlackboardStore {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  getSnapshot(): Record<string, unknown>;
}

export class InMemoryBlackboard implements BlackboardStore {
  private readonly state: Record<string, unknown> = {};

  get<T = unknown>(key: string): T | undefined {
    return this.state[key] as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.state[key] = value;
  }

  getSnapshot(): Record<string, unknown> {
    return { ...this.state };
  }
}

/**
 * task.update: Updates a task in the mission blackboard.
 */
export async function updateTask(
  input: TaskUpdateInput,
  store: BlackboardStore
): Promise<ToolResult> {
  const startTime = Date.now();
  try {
    if (!input || typeof input !== "object") {
      return {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Input must be an object.",
          recovery: "Provide a valid TaskUpdateInput object.",
        },
        durationMs: Date.now() - startTime,
      };
    }

    if (!input.taskId || typeof input.taskId !== "string" || !input.taskId.trim()) {
      return {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "taskId must be a non-empty string.",
          recovery: "Provide a valid taskId string.",
        },
        durationMs: Date.now() - startTime,
      };
    }

    const tasks = (store.get<Record<string, unknown>>("tasks") || {}) as Record<
      string,
      Record<string, unknown>
    >;
    const existing = tasks[input.taskId] || {};

    const updatedTask: Record<string, unknown> = {
      ...existing,
      taskId: input.taskId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.filesTouched !== undefined
        ? { filesTouched: input.filesTouched }
        : {}),
      updatedAt: new Date().toISOString(),
    };

    const newTasks = {
      ...tasks,
      [input.taskId]: updatedTask,
    };

    store.set("tasks", newTasks);

    return {
      ok: true,
      result: {
        taskId: input.taskId,
        task: updatedTask,
      },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: {
        code: "TASK_UPDATE_FAILED",
        message: err?.message || String(err),
        recovery: "Check input format and retry task update.",
      },
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * blackboard.set: Sets a key-value pair in the mission blackboard.
 */
export async function setBlackboard(
  input: BlackboardSetInput,
  store: BlackboardStore
): Promise<ToolResult> {
  const startTime = Date.now();
  try {
    if (!input || typeof input !== "object") {
      return {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Input must be an object.",
          recovery: "Provide a valid BlackboardSetInput object.",
        },
        durationMs: Date.now() - startTime,
      };
    }

    if (input.key === undefined || typeof input.key !== "string" || !input.key.trim()) {
      return {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "key must be a non-empty string.",
          recovery: "Provide a valid string key.",
        },
        durationMs: Date.now() - startTime,
      };
    }

    store.set(input.key, input.value);

    return {
      ok: true,
      result: {
        key: input.key,
        value: input.value,
      },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: {
        code: "BLACKBOARD_SET_FAILED",
        message: err?.message || String(err),
        recovery: "Ensure key and value are serializable and retry.",
      },
      durationMs: Date.now() - startTime,
    };
  }
}
