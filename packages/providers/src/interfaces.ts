import { ChatStreamEvent } from "@aether/protocol";

export interface ChatRequest {
  model: string;
  messages: any[];
  tools?: any[];
  temperature?: number;
  max_tokens?: number;
}

export interface ModelInfo {
  id: string;
  context_length: number;
  pricing: any;
}

export interface LLMProvider {
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatStreamEvent>;
  models(): Promise<ModelInfo[]>;
  countTokens(text: string, model: string): number;
}
