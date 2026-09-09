import { CodeChunk } from "./types.js";

export interface ChunkerOptions {
  chunkSize?: number;
  overlap?: number;
}

/**
 * Chunks a file's content into overlapping line ranges, preserving line-level metadata.
 */
export function chunkFileContent(
  filepath: string,
  content: string,
  options: ChunkerOptions = {}
): CodeChunk[] {
  if (!content || !content.trim()) {
    return [];
  }

  const chunkSize = options.chunkSize ?? 40;
  const overlap = options.overlap ?? 5;
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (totalLines <= chunkSize) {
    return [
      {
        id: `${filepath}#L1-L${totalLines}`,
        filepath,
        content,
        startLine: 1,
        endLine: totalLines,
      },
    ];
  }

  const chunks: CodeChunk[] = [];
  let currentStart = 1;
  let chunkIndex = 0;

  while (currentStart <= totalLines) {
    const currentEnd = Math.min(currentStart + chunkSize - 1, totalLines);
    const chunkContent = lines.slice(currentStart - 1, currentEnd).join("\n");

    chunks.push({
      id: `${filepath}#chunk_${chunkIndex++}_L${currentStart}-L${currentEnd}`,
      filepath,
      content: chunkContent,
      startLine: currentStart,
      endLine: currentEnd,
    });

    if (currentEnd >= totalLines) {
      break;
    }

    // Advance by chunkSize - overlap
    currentStart += Math.max(1, chunkSize - overlap);
  }

  return chunks;
}
