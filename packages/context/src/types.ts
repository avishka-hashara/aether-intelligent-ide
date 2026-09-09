export interface CodeChunk {
  id: string;
  filepath: string;
  content: string;
  startLine: number;
  endLine: number;
}

export interface SearchResult {
  filepath: string;
  content: string;
  startLine: number;
  endLine: number;
  distance?: number;
  score?: number;
}

export interface VectorStoreOptions {
  client?: any;
  collection?: any;
  collectionName?: string;
  path?: string;
}

export interface ScanOptions {
  ignorePatterns?: string[];
  maxFileSizeKb?: number;
}

export interface ScanResult {
  indexedFiles: number;
  totalChunks: number;
  errors?: Array<{ filepath: string; error: string }>;
}
