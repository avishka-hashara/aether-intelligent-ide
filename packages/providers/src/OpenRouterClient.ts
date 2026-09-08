import { ChatStreamEvent } from "@aether/protocol";
import { ChatRequest, LLMProvider, ModelInfo } from "./interfaces.js";

export interface OpenRouterClientOptions {
  apiKey?: string;
  baseUrl?: string;
  defaultHeaders?: Record<string, string>;
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  args: string;
}

export class OpenRouterClient implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private defaultHeaders: Record<string, string>;

  constructor(optionsOrApiKey?: string | OpenRouterClientOptions) {
    if (typeof optionsOrApiKey === "string") {
      this.apiKey = optionsOrApiKey;
      this.baseUrl = "https://openrouter.ai/api/v1";
      this.defaultHeaders = {};
    } else {
      this.apiKey =
        optionsOrApiKey?.apiKey ??
        (typeof process !== "undefined" ? process.env?.OPENROUTER_API_KEY ?? "" : "");
      this.baseUrl =
        optionsOrApiKey?.baseUrl ?? "https://openrouter.ai/api/v1";
      this.defaultHeaders = optionsOrApiKey?.defaultHeaders ?? {};
    }
  }

  async *chat(
    req: ChatRequest,
    signal: AbortSignal
  ): AsyncIterable<ChatStreamEvent> {
    if (signal?.aborted) {
      return;
    }

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.apiKey}`,
      "HTTP-Referer": "https://aether.dev",
      "X-OpenRouter-Title": "Aether IDE",
      "Content-Type": "application/json",
      ...this.defaultHeaders,
    };

    const { model, messages, tools, temperature, max_tokens, ...extra } = req as any;

    const payload: Record<string, any> = {
      model,
      messages,
      ...(tools !== undefined ? { tools } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(max_tokens !== undefined ? { max_tokens } : {}),
      ...extra,
      stream: true,
      usage: { include: true },
      provider: {
        require_parameters: true,
        data_collection: "deny",
      },
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
      });
    } catch (err: any) {
      if (signal?.aborted || err?.name === "AbortError") {
        return;
      }
      yield {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      };
      return;
    }

    if (!response.ok) {
      let errorMessage = `OpenRouter API error (${response.status} ${response.statusText})`;
      try {
        const errorBody = await response.text();
        if (errorBody) {
          errorMessage += `: ${errorBody}`;
        }
      } catch {}
      yield { type: "error", message: errorMessage };
      return;
    }

    if (!response.body) {
      yield { type: "error", message: "Response body is empty" };
      return;
    }

    const toolCallsMap = new Map<number, AccumulatedToolCall>();
    let doneYielded = false;

    try {
      for await (const line of this.readLines(response.body)) {
        if (signal?.aborted) {
          return;
        }

        const trimmed = line.trim();
        if (!trimmed) continue;

        // Ignore SSE comments
        if (trimmed.startsWith(":")) {
          continue;
        }

        if (trimmed.startsWith("data:")) {
          const dataStr = trimmed.replace(/^data:\s*/, "").trim();

          if (dataStr === "[DONE]") {
            if (!doneYielded) {
              doneYielded = true;
              yield { type: "done" };
            }
            return;
          }

          let parsed: any;
          try {
            parsed = JSON.parse(dataStr);
          } catch {
            continue;
          }

          if (parsed.error) {
            const message =
              typeof parsed.error === "string"
                ? parsed.error
                : parsed.error.message || JSON.stringify(parsed.error);
            yield { type: "error", message };
            continue;
          }

          const choice = parsed.choices?.[0];

          // Text content delta
          if (choice?.delta?.content) {
            yield {
              type: "text_delta",
              text: choice.delta.content,
            };
          }

          // Reasoning content delta (e.g. DeepSeek-R1, thinking models)
          const reasoning =
            choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
          if (reasoning) {
            yield {
              type: "reasoning_delta",
              text: reasoning,
            };
          }

          // Tool call assembly
          const toolCalls = choice?.delta?.tool_calls;
          if (Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
              const idx = tc.index ?? 0;
              let accumulated = toolCallsMap.get(idx);
              if (!accumulated) {
                accumulated = { id: "", name: "", args: "" };
                toolCallsMap.set(idx, accumulated);
              }

              const fnName = tc.function?.name ?? tc.name;
              const fnArgs = tc.function?.arguments ?? tc.args;

              if (tc.id) {
                accumulated.id += tc.id;
              }
              if (fnName) {
                accumulated.name += fnName;
              }
              if (fnArgs) {
                accumulated.args += fnArgs;
              }

              yield {
                type: "tool_call_delta",
                index: idx,
                ...(tc.id !== undefined ? { id: tc.id } : {}),
                ...(fnName !== undefined ? { name: fnName } : {}),
                ...(fnArgs !== undefined ? { args: fnArgs } : {}),
              };
            }
          }

          // Yield completed tool calls when finish_reason === "tool_calls"
          if (choice?.finish_reason === "tool_calls") {
            const sortedCalls = Array.from(toolCallsMap.entries()).sort(
              ([a], [b]) => a - b
            );
            for (const [_index, tc] of sortedCalls) {
              yield {
                type: "tool_call_complete",
                id: tc.id,
                name: tc.name,
                args: tc.args,
              };
            }
            toolCallsMap.clear();
          }

          // Usage capture: parse chunk before [DONE]
          const usageObj = parsed.usage ?? choice?.usage;
          if (usageObj) {
            const promptTokens =
              usageObj.prompt_tokens ?? usageObj.promptTokens ?? 0;
            const completionTokens =
              usageObj.completion_tokens ?? usageObj.completionTokens ?? 0;

            yield {
              type: "usage",
              promptTokens,
              completionTokens,
            };
          }
        }
      }

      if (!doneYielded) {
        doneYielded = true;
        yield { type: "done" };
      }
    } catch (err: any) {
      if (signal?.aborted || err?.name === "AbortError") {
        return;
      }
      yield {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async models(): Promise<ModelInfo[]> {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.apiKey}`,
      "HTTP-Referer": "https://aether.dev",
      "X-OpenRouter-Title": "Aether IDE",
      ...this.defaultHeaders,
    };

    const response = await fetch(`${this.baseUrl}/models`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenRouter models failed (${response.status} ${response.statusText}): ${errorText}`
      );
    }

    const json = (await response.json()) as { data?: any[] };
    const data = Array.isArray(json?.data) ? json.data : [];

    return data.map((item: any) => ({
      id: String(item.id),
      context_length: Number(item.context_length ?? item.context_window ?? 0),
      pricing: item.pricing ?? {},
    }));
  }

  countTokens(text: string, _model: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  private async *readLines(
    body: ReadableStream<Uint8Array>
  ): AsyncIterable<string> {
    const decoder = new TextDecoder();
    let buffer = "";

    const streamIterator = (body as any)[Symbol.asyncIterator]
      ? (body as AsyncIterable<Uint8Array>)
      : (async function* () {
          const reader = body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) yield value;
            }
          } finally {
            reader.releaseLock();
          }
        })();

    for await (const chunk of streamIterator) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        yield line;
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      const lines = buffer.split(/\r?\n/);
      for (const line of lines) {
        yield line;
      }
    }
  }
}
