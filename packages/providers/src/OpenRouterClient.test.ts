import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenRouterClient } from "./OpenRouterClient.js";
import { ChatRequest } from "./interfaces.js";
import { ChatStreamEvent } from "@aether/protocol";

function createMockStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

describe("OpenRouterClient", () => {
  const apiKey = "test-api-key";
  let client: OpenRouterClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    client = new OpenRouterClient(apiKey);
  });

  it("should configure headers, payload, and endpoint correctly", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const sseResponse = [
      ": OPENROUTER PROCESSING\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"Hello world\"}}]}\n\n",
      "data: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n",
      "data: [DONE]\n\n",
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(createMockStream(sseResponse), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      })
    );

    const controller = new AbortController();
    const req: ChatRequest = {
      model: "anthropic/claude-3.5-sonnet",
      messages: [{ role: "user", content: "Hi" }],
      temperature: 0.7,
      max_tokens: 100,
    };

    const events: ChatStreamEvent[] = [];
    for await (const ev of client.chat(req, controller.signal)) {
      events.push(ev);
    }

    expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(capturedInit?.method).toBe("POST");

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${apiKey}`);
    expect(headers["HTTP-Referer"]).toBe("https://aether.dev");
    expect(headers["X-OpenRouter-Title"]).toBe("Aether IDE");
    expect(headers["Content-Type"]).toBe("application/json");

    const payload = JSON.parse(capturedInit?.body as string);
    expect(payload.model).toBe("anthropic/claude-3.5-sonnet");
    expect(payload.messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(payload.temperature).toBe(0.7);
    expect(payload.max_tokens).toBe(100);
    expect(payload.stream).toBe(true);
    expect(payload.usage).toEqual({ include: true });
    expect(payload.provider).toEqual({
      require_parameters: true,
      data_collection: "deny",
    });

    // Check parsed events
    expect(events).toEqual([
      { type: "text_delta", text: "Hello world" },
      { type: "usage", promptTokens: 10, completionTokens: 5 },
      { type: "done" },
    ]);
  });

  it("should stream reasoning_delta and ignore SSE comments", async () => {
    const sseResponse = [
      ": comment 1\n",
      ": comment 2\n",
      "data: {\"choices\":[{\"delta\":{\"reasoning\":\"Thinking about the query...\"}}]}\n\n",
      ": comment 3\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"Final answer\"}}]}\n\n",
      "data: [DONE]\n\n",
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(createMockStream(sseResponse), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      })
    );

    const controller = new AbortController();
    const events: ChatStreamEvent[] = [];
    for await (const ev of client.chat(
      { model: "deepseek/deepseek-r1", messages: [] },
      controller.signal
    )) {
      events.push(ev);
    }

    expect(events).toEqual([
      { type: "reasoning_delta", text: "Thinking about the query..." },
      { type: "text_delta", text: "Final answer" },
      { type: "done" },
    ]);
  });

  it("should assemble tool calls across fragmented chunks and yield tool_call_complete", async () => {
    const sseResponse = [
      // Chunk 1: first tool call header (id, function name)
      "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_123\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n",
      // Chunk 2: arguments fragment 1
      "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\": \\\"\"}}]},\"finish_reason\":null}]}\n\n",
      // Chunk 3: arguments fragment 2
      "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"src/index.ts\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
      // Chunk 4: finish_reason tool_calls + usage
      "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":25,\"completion_tokens\":40}}\n\n",
      "data: [DONE]\n\n",
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(createMockStream(sseResponse), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      })
    );

    const controller = new AbortController();
    const events: ChatStreamEvent[] = [];
    for await (const ev of client.chat(
      { model: "openai/gpt-4o", messages: [] },
      controller.signal
    )) {
      events.push(ev);
    }

    expect(events).toEqual([
      {
        type: "tool_call_delta",
        index: 0,
        id: "call_123",
        name: "read_file",
        args: "",
      },
      {
        type: "tool_call_delta",
        index: 0,
        args: "{\"path\": \"",
      },
      {
        type: "tool_call_delta",
        index: 0,
        args: "src/index.ts\"}",
      },
      {
        type: "tool_call_complete",
        id: "call_123",
        name: "read_file",
        args: "{\"path\": \"src/index.ts\"}",
      },
      {
        type: "usage",
        promptTokens: 25,
        completionTokens: 40,
      },
      {
        type: "done",
      },
    ]);
  });

  it("should handle parallel tool calls streaming concurrently", async () => {
    const sseResponse = [
      "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"fn1\",\"arguments\":\"{\\\"a\\\":1}\"}},{\"index\":1,\"id\":\"call_2\",\"function\":{\"name\":\"fn2\",\"arguments\":\"{\\\"b\\\":2}\"}}]},\"finish_reason\":null}]}\n\n",
      "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
      "data: [DONE]\n\n",
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(createMockStream(sseResponse), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      })
    );

    const controller = new AbortController();
    const events: ChatStreamEvent[] = [];
    for await (const ev of client.chat(
      { model: "openai/gpt-4o", messages: [] },
      controller.signal
    )) {
      events.push(ev);
    }

    const completeEvents = events.filter((e) => e.type === "tool_call_complete");
    expect(completeEvents).toEqual([
      {
        type: "tool_call_complete",
        id: "call_1",
        name: "fn1",
        args: "{\"a\":1}",
      },
      {
        type: "tool_call_complete",
        id: "call_2",
        name: "fn2",
        args: "{\"b\":2}",
      },
    ]);
  });

  it("should pass AbortSignal directly to fetch and abort properly", async () => {
    const controller = new AbortController();
    controller.abort();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const events: ChatStreamEvent[] = [];
    for await (const ev of client.chat(
      { model: "test", messages: [] },
      controller.signal
    )) {
      events.push(ev);
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("should fetch models correctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        expect(String(url)).toBe("https://openrouter.ai/api/v1/models");
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "openai/gpt-4o",
                context_length: 128000,
                pricing: { prompt: "0.000005", completion: "0.000015" },
              },
              {
                id: "anthropic/claude-3.5-sonnet",
                context_length: 200000,
                pricing: { prompt: "0.000003", completion: "0.000015" },
              },
            ],
          }),
          { status: 200 }
        );
      })
    );

    const models = await client.models();
    expect(models).toEqual([
      {
        id: "openai/gpt-4o",
        context_length: 128000,
        pricing: { prompt: "0.000005", completion: "0.000015" },
      },
      {
        id: "anthropic/claude-3.5-sonnet",
        context_length: 200000,
        pricing: { prompt: "0.000003", completion: "0.000015" },
      },
    ]);
  });

  it("should count tokens approximately", () => {
    expect(client.countTokens("", "any-model")).toBe(0);
    expect(client.countTokens("hello", "any-model")).toBe(2);
    expect(client.countTokens("This is a test message.", "any-model")).toBe(6);
  });
});
