export interface Budget {
  maxUsd: number;
  maxTokens: number;
  maxWallClockMs: number;
  maxToolCalls: number;
}

export type BudgetBreachReason =
  | "maxUsd"
  | "maxTokens"
  | "maxWallClockMs"
  | "maxToolCalls";

export class BudgetExhaustedError extends Error {
  constructor(
    readonly reason: BudgetBreachReason,
    readonly current: number,
    readonly limit: number
  ) {
    let detail = "";
    switch (reason) {
      case "maxUsd":
        detail = `spend of $${current.toFixed(4)} reached or exceeded limit of $${limit.toFixed(4)}`;
        break;
      case "maxTokens":
        detail = `token count of ${current} reached or exceeded limit of ${limit}`;
        break;
      case "maxWallClockMs":
        detail = `elapsed time of ${current}ms reached or exceeded limit of ${limit}ms`;
        break;
      case "maxToolCalls":
        detail = `tool call count of ${current} reached or exceeded limit of ${limit}`;
        break;
    }
    super(`BudgetExhaustedError: ${detail}`);
    this.name = "BudgetExhaustedError";
    Object.setPrototypeOf(this, BudgetExhaustedError.prototype);
  }
}

export class BudgetTracker {
  private currentUsdVal = 0;
  private currentTokensVal = 0;
  private currentToolCallsVal = 0;
  readonly startTime: number;

  constructor(
    readonly budget: Budget,
    options?: { startTime?: number }
  ) {
    this.startTime = options?.startTime ?? Date.now();
  }

  get currentUsd(): number {
    return this.currentUsdVal;
  }

  get currentTokens(): number {
    return this.currentTokensVal;
  }

  get currentToolCalls(): number {
    return this.currentToolCallsVal;
  }

  get elapsedMs(): number {
    return Date.now() - this.startTime;
  }

  recordUsage(tokens: number, costUsd: number = 0): void {
    if (tokens > 0) {
      this.currentTokensVal += tokens;
    }
    if (costUsd > 0) {
      this.currentUsdVal += costUsd;
    }
  }

  recordToolCall(count: number = 1): void {
    this.currentToolCallsVal += count;
  }

  check(): void {
    if (this.budget.maxUsd > 0 && this.currentUsdVal >= this.budget.maxUsd) {
      throw new BudgetExhaustedError(
        "maxUsd",
        this.currentUsdVal,
        this.budget.maxUsd
      );
    }
    if (
      this.budget.maxTokens > 0 &&
      this.currentTokensVal >= this.budget.maxTokens
    ) {
      throw new BudgetExhaustedError(
        "maxTokens",
        this.currentTokensVal,
        this.budget.maxTokens
      );
    }
    if (
      this.budget.maxWallClockMs > 0 &&
      this.elapsedMs >= this.budget.maxWallClockMs
    ) {
      throw new BudgetExhaustedError(
        "maxWallClockMs",
        this.elapsedMs,
        this.budget.maxWallClockMs
      );
    }
    if (
      this.budget.maxToolCalls > 0 &&
      this.currentToolCallsVal >= this.budget.maxToolCalls
    ) {
      throw new BudgetExhaustedError(
        "maxToolCalls",
        this.currentToolCallsVal,
        this.budget.maxToolCalls
      );
    }
  }

  getSnapshot() {
    return {
      currentUsd: this.currentUsdVal,
      currentTokens: this.currentTokensVal,
      currentToolCalls: this.currentToolCallsVal,
      elapsedMs: this.elapsedMs,
      budget: { ...this.budget },
    };
  }
}
