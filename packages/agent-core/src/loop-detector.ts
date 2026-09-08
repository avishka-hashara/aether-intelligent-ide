/**
 * LoopDetector tracks the sequence of tool calls and detects infinite repetitions.
 * If the exact same tool name and arguments are executed three times consecutively,
 * addAndCheck returns true.
 */
export class LoopDetector {
  private lastFingerprint: string | null = null;
  private consecutiveCount: number = 0;
  private readonly history: Array<{
    toolName: string;
    argsRaw: string;
    fingerprint: string;
  }> = [];

  /**
   * Normalizes argument string to create a deterministic fingerprint.
   */
  private normalizeArgs(argsRaw: string): string {
    if (!argsRaw || !argsRaw.trim()) {
      return "";
    }
    try {
      const parsed = JSON.parse(argsRaw);
      return JSON.stringify(parsed);
    } catch {
      return argsRaw.trim();
    }
  }

  /**
   * Records a tool call and checks if it has been repeated 3 times consecutively.
   *
   * @param toolName Name of the tool called.
   * @param argsRaw Raw JSON arguments string of the tool call.
   * @returns true if the exact same tool and arguments were executed 3 times consecutively, otherwise false.
   */
  addAndCheck(toolName: string, argsRaw: string): boolean {
    const normalized = this.normalizeArgs(argsRaw);
    const fingerprint = `${toolName}:${normalized}`;

    this.history.push({ toolName, argsRaw, fingerprint });

    if (fingerprint === this.lastFingerprint) {
      this.consecutiveCount++;
    } else {
      this.lastFingerprint = fingerprint;
      this.consecutiveCount = 1;
    }

    return this.consecutiveCount >= 3;
  }

  /**
   * Resets the detector history and counter.
   */
  reset(): void {
    this.lastFingerprint = null;
    this.consecutiveCount = 0;
    this.history.length = 0;
  }

  get currentConsecutive(): number {
    return this.consecutiveCount;
  }

  get callHistory(): ReadonlyArray<{ toolName: string; argsRaw: string }> {
    return this.history;
  }
}
