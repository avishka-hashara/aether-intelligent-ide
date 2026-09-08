import { OpenRouterClient } from "@aether/providers";
import { ChatRequest } from "@aether/providers";

import * as fs from "node:fs";

async function main() {
  if (!process.env.OPENROUTER_API_KEY && fs.existsSync(".env")) {
    const envContent = fs.readFileSync(".env", "utf-8");
    for (const line of envContent.split(/\r?\n/)) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = (match[2] || "").trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }

  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    console.warn(
      "[WARN] OPENROUTER_API_KEY is not set. Skipping live OpenRouter smoke test."
    );
    process.exit(0);
  }

  console.log("Initializing OpenRouterClient smoke test...");
  const client = new OpenRouterClient(apiKey);

  const req: ChatRequest = {
    model: "anthropic/claude-3-haiku-20240307",
    messages: [
      {
        role: "user",
        content: "What is the weather in Tokyo?",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the current weather in a given location.",
          parameters: {
            type: "object",
            properties: {
              location: {
                type: "string",
                description: "The city and state, e.g. Tokyo, Japan",
              },
              unit: {
                type: "string",
                enum: ["celsius", "fahrenheit"],
              },
            },
            required: ["location"],
          },
        },
      },
    ],
    temperature: 0.1,
  };

  const controller = new AbortController();
  let receivedToolCallComplete = false;
  let receivedUsage = false;
  let toolCallName = "";
  let toolCallArgs = "";

  console.log("Sending chat request to OpenRouter with get_weather tool...");

  for await (const event of client.chat(req, controller.signal)) {
    switch (event.type) {
      case "text_delta":
        process.stdout.write(event.text);
        break;

      case "reasoning_delta":
        process.stdout.write(`\n[Thinking] ${event.text}\n`);
        break;

      case "tool_call_delta":
        if (event.name) {
          toolCallName = event.name;
        }
        if (event.args) {
          toolCallArgs += event.args;
        }
        break;

      case "tool_call_complete":
        receivedToolCallComplete = true;
        console.log("\n[Tool Call Complete]:", {
          id: event.id,
          name: event.name,
          args: event.args,
        });
        if (event.name !== "get_weather") {
          throw new Error(
            `Expected tool_call_complete for 'get_weather', but received '${event.name}'`
          );
        }
        break;

      case "usage":
        receivedUsage = true;
        console.log("\n[Usage]:", {
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
          totalTokens: event.promptTokens + event.completionTokens,
          estimatedCostUsd: (
            (event.promptTokens * 0.00000025 +
              event.completionTokens * 0.00000125)
          ).toFixed(6),
        });
        break;

      case "error":
        console.error("\n[Error Event]:", event.message);
        throw new Error(`Chat stream error: ${event.message}`);

      case "done":
        console.log("\n[Stream Finished]");
        break;
    }
  }

  if (!receivedToolCallComplete) {
    throw new Error(
      "Smoke test failed: 'tool_call_complete' event was not yielded for get_weather."
    );
  }

  if (!receivedUsage) {
    throw new Error("Smoke test failed: 'usage' event was not yielded.");
  }

  console.log("Smoke test passed successfully!");
}

main().catch((err) => {
  console.error("Smoke test failed with error:", err);
  process.exit(1);
});
