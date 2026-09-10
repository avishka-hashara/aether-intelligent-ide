import * as fs from "node:fs";
import * as path from "node:path";
import { ChromaClient } from "chromadb";
import { chunkFileContent } from "./chunker.js";
import {
  ChromaEmbeddingFunction,
  LocalEmbeddingFunction,
  cosineDistance,
} from "./embedding.js";
import { CodeChunk, SearchResult, VectorStoreOptions } from "./types.js";

interface StoredVectorRecord {
  id: string;
  filepath: string;
  content: string;
  startLine: number;
  endLine: number;
  embedding: number[];
}

export class VectorStoreService {
  private client?: any;
  private collection?: any;
  private collectionName: string;
  private serverPath: string;
  private embeddingFunction: ChromaEmbeddingFunction;
  private isHttpEndpoint: boolean;
  private localRecords = new Map<string, StoredVectorRecord>();
  private localLoaded = false;
  private localSaveTimer?: NodeJS.Timeout;

  constructor(options: VectorStoreOptions = {}) {
    this.collectionName = options.collectionName || "aether-codebase";
    this.serverPath = options.path || "http://127.0.0.1:8000";
    this.embeddingFunction =
      options.embeddingFunction || new LocalEmbeddingFunction();

    this.isHttpEndpoint =
      typeof this.serverPath === "string" &&
      (this.serverPath.startsWith("http://") ||
        this.serverPath.startsWith("https://"));

    if (options.collection) {
      this.collection = options.collection;
    } else if (options.client) {
      this.client = options.client;
    }
  }

  /**
   * Lazily initializes and caches the ChromaDB collection instance or local fallback.
   */
  async getCollection(): Promise<any> {
    if (this.collection) {
      return this.collection;
    }

    if (this.isHttpEndpoint) {
      try {
        if (!this.client) {
          this.client = new ChromaClient({ path: this.serverPath });
        }

        this.collection = await this.client.getOrCreateCollection({
          name: this.collectionName,
          embeddingFunction: this.embeddingFunction,
          metadata: { description: "Aether persistent codebase vector index" },
        });

        return this.collection;
      } catch (err: any) {
        // Fall back gracefully to local store if Chroma server is offline
        this.ensureLocalStoreLoaded();
        return null;
      }
    }

    // Local filesystem path configured (e.g. .aether/chroma)
    this.ensureLocalStoreLoaded();
    return null;
  }

  private ensureLocalStoreLoaded(): void {
    if (this.localLoaded) {
      return;
    }
    this.localLoaded = true;

    if (this.isHttpEndpoint) {
      return;
    }

    try {
      if (!fs.existsSync(this.serverPath)) {
        fs.mkdirSync(this.serverPath, { recursive: true });
      }

      const filePath = path.join(this.serverPath, "vectors.json");
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && item.id) {
              this.localRecords.set(item.id, item);
            }
          }
        }
      }
    } catch {
      // Best-effort local storage loading
    }
  }

  private scheduleLocalSave(): void {
    if (this.isHttpEndpoint || !this.serverPath) {
      return;
    }

    if (this.localSaveTimer) {
      clearTimeout(this.localSaveTimer);
    }

    this.localSaveTimer = setTimeout(() => {
      try {
        if (!fs.existsSync(this.serverPath)) {
          fs.mkdirSync(this.serverPath, { recursive: true });
        }
        const filePath = path.join(this.serverPath, "vectors.json");
        const records = Array.from(this.localRecords.values());
        fs.writeFileSync(filePath, JSON.stringify(records, null, 2), "utf8");
      } catch {
        // Non-blocking disk write
      }
    }, 200);
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

    if (collection) {
      if (typeof collection.upsert === "function") {
        await collection.upsert({
          ids,
          documents,
          metadatas,
        });
      } else if (typeof collection.add === "function") {
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

    // Local embedded vector store
    this.ensureLocalStoreLoaded();
    const embeddings = await this.embeddingFunction.generate(documents);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i] || [];
      this.localRecords.set(chunk.id, {
        id: chunk.id,
        filepath: chunk.filepath,
        content: chunk.content,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        embedding,
      });
    }

    this.scheduleLocalSave();
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

    if (collection && typeof collection.query === "function") {
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

    // Local embedded vector search
    this.ensureLocalStoreLoaded();
    if (this.localRecords.size === 0) {
      return [];
    }

    const [queryVec] = await this.embeddingFunction.generate([query]);
    if (!queryVec || queryVec.length === 0) {
      return [];
    }

    const scoredItems: Array<{
      record: StoredVectorRecord;
      distance: number;
      score: number;
    }> = [];

    for (const record of this.localRecords.values()) {
      const dist = cosineDistance(queryVec, record.embedding);
      const score = 1 / (1 + dist);
      scoredItems.push({
        record,
        distance: dist,
        score,
      });
    }

    // Sort by smallest distance / highest score
    scoredItems.sort((a, b) => a.distance - b.distance);

    return scoredItems.slice(0, limit).map((item) => ({
      filepath: item.record.filepath,
      content: item.record.content,
      startLine: item.record.startLine,
      endLine: item.record.endLine,
      distance: item.distance,
      score: item.score,
    }));
  }
}
