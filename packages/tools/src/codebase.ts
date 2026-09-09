import { ToolResult } from "@aether/protocol";

export interface CodebaseSearchInput {
  query: string;
  maxResults?: number;
}

export interface CodebaseMatch {
  filepath: string;
  lines: string;
  score?: number;
  snippet: string;
}

export interface CodebaseToolContext {
  vectorStore?: any;
  workspaceRoot?: string;
}

/**
 * codebase.search tool:
 * Performs semantic similarity search across the indexed codebase.
 */
export async function searchCodebase(
  input: CodebaseSearchInput,
  context?: CodebaseToolContext
): Promise<ToolResult> {
  const startTime = Date.now();

  if (!input || !input.query || !input.query.trim()) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: "Missing required query string.",
        recovery: "Provide a natural language or code concept query to search for.",
      },
      durationMs: Date.now() - startTime,
    };
  }

  const query = input.query.trim();
  const maxResults = input.maxResults && input.maxResults > 0 ? input.maxResults : 5;

  if (!context?.vectorStore) {
    return {
      ok: true,
      result: {
        query,
        count: 0,
        matches: [],
        message: "No vector store instance provided in context.",
      },
      durationMs: Date.now() - startTime,
    };
  }

  try {
    const rawMatches = await context.vectorStore.search(query, maxResults);
    const matches: CodebaseMatch[] = (rawMatches || []).map((m: any) => ({
      filepath: m.filepath,
      lines: `L${m.startLine}-L${m.endLine}`,
      score: m.score !== undefined ? Number(m.score.toFixed(3)) : undefined,
      snippet: m.content,
    }));

    return {
      ok: true,
      result: {
        query,
        count: matches.length,
        matches,
      },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: {
        code: "search_error",
        message: err?.message || String(err),
        recovery: "Verify that ChromaDB is running and the index has been built.",
      },
      durationMs: Date.now() - startTime,
    };
  }
}
