import { ChromaClient } from "chromadb";
import { chunkFileContent } from "./chunker.js";
import { CodeChunk, SearchResult, VectorStoreOptions } from "./types.js";

export class VectorStoreService {
  private client?: any;
  private collection?: any;
  private collectionName: string;
  private serverPath: string;

  constructor(options: VectorStoreOptions = {}) {
    this.collectionName = options.collectionName || "aether-codebase";
    this.serverPath = options.path || "http://127.0.0.1:8000";

    if (options.collection) {
      this.collection = options.collection;
    } else if (options.client) {
      this.client = options.client;
    }
  }

  /**
   * Lazily initializes and caches the ChromaDB collection instance.
   */
  async getCollection(): Promise<any> {
    if (this.collection) {
      return this.collection;
    }

    if (!this.client) {
      this.client = new ChromaClient({ path: this.serverPath });
    }

    this.collection = await this.client.getOrCreateCollection({
      name: this.collectionName,
      metadata: { description: "Aether persistent codebase vector index" },
    });

    return this.collection;
  }

  /**
   * Chunks file content into line ranges and upserts into the vector database.
   */
  async upsertFile(filepath: string, content: string): Promise<CodeChunk[]> {
    const chunks = chunkFileContent(filepath, content);
    if (chunks.length === 0) {
      return [];
    }

    const collection = await this.getCollection();

    const ids = chunks.map((c) => c.id);
    const documents = chunks.map((c) => c.content);
    const metadatas = chunks.map((c) => ({
      filepath: c.filepath,
      startLine: c.startLine,
      endLine: c.endLine,
    }));

    if (typeof collection.upsert === "function") {
      await collection.upsert({
        ids,
        documents,
        metadatas,
      });
    } else if (typeof collection.add === "function") {
      // Fallback if upsert is not implemented in mock/driver
      if (typeof collection.delete === "function") {
        try {
          await collection.delete({ ids });
        } catch {
          // Ignore if IDs didn't exist yet
        }
      }
      await collection.add({
        ids,
        documents,
        metadatas,
      });
    }

    return chunks;
  }

  /**
   * Performs semantic vector search and returns the top relevant code chunks.
   */
  async search(query: string, limit: number = 5): Promise<SearchResult[]> {
    if (!query || !query.trim()) {
      return [];
    }

    const collection = await this.getCollection();
    const queryResults = await collection.query({
      queryTexts: [query],
      nResults: limit,
    });

    const results: SearchResult[] = [];
    const documents = queryResults.documents?.[0] || [];
    const metadatas = queryResults.metadatas?.[0] || [];
    const distances = queryResults.distances?.[0] || [];

    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      const meta = metadatas[i] || {};
      const distance = distances[i];

      if (doc) {
        results.push({
          filepath: meta.filepath || "unknown",
          content: doc,
          startLine: meta.startLine || 1,
          endLine: meta.endLine || 1,
          distance: typeof distance === "number" ? distance : undefined,
          score:
            typeof distance === "number" ? 1 / (1 + distance) : undefined,
        });
      }
    }

    return results;
  }
}
