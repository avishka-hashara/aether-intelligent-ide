export interface ChromaEmbeddingFunction {
  name?: string;
  generate(texts: string[]): Promise<number[][]>;
  generateForQueries?(texts: string[]): Promise<number[][]>;
}

/**
 * Deterministic code embedding function:
 * Produces a normalized feature-hashed vector of token and n-gram frequencies.
 * Operates purely in-memory with zero native dependencies or large model downloads.
 */
export function embedCodeText(text: string, dimensions: number = 256): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  if (!text || !text.trim()) {
    return vector;
  }

  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);

  if (tokens.length === 0) {
    return vector;
  }

  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const idx = Math.abs(hash) % dimensions;
    vector[idx] += 1;

    // 3-gram subwords for identifier fragments (e.g. "auth", "login", "store")
    if (token.length >= 3) {
      for (let i = 0; i <= token.length - 3; i++) {
        const sub = token.substring(i, i + 3);
        let subHash = 2166136261;
        for (let j = 0; j < sub.length; j++) {
          subHash ^= sub.charCodeAt(j);
          subHash = Math.imul(subHash, 16777619);
        }
        const subIdx = Math.abs(subHash) % dimensions;
        vector[subIdx] += 0.5;
      }
    }
  }

  let norm = 0;
  for (let i = 0; i < dimensions; i++) {
    norm += vector[i] * vector[i];
  }
  if (norm > 0) {
    norm = Math.sqrt(norm);
    for (let i = 0; i < dimensions; i++) {
      vector[i] /= norm;
    }
  }

  return vector;
}

/**
 * Computes cosine distance between two unit-normalized vectors:
 * range: [0, 2], where 0 indicates identical orientation.
 */
export function cosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 1;
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  dot = Math.max(-1, Math.min(1, dot));
  return 1 - dot;
}

/**
 * Default local embedding function compatible with Chroma's EmbeddingFunction interface.
 */
export class LocalEmbeddingFunction implements ChromaEmbeddingFunction {
  readonly name = "local-code-embed";

  async generate(texts: string[]): Promise<number[][]> {
    return texts.map((t) => embedCodeText(t));
  }

  async generateForQueries(texts: string[]): Promise<number[][]> {
    return this.generate(texts);
  }
}
