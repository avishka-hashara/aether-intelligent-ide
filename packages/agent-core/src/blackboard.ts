/**
 * Blackboard maintains a mission-scoped key-value state for agent coordination.
 */
export class Blackboard {
  private readonly state: Record<string, unknown>;

  constructor(initialState: Record<string, unknown> = {}) {
    this.state = { ...initialState };
  }

  /**
   * Retrieves a value from the blackboard by key.
   */
  get<T = unknown>(key: string): T | undefined {
    return this.state[key] as T | undefined;
  }

  /**
   * Sets a key-value pair in the blackboard.
   */
  set(key: string, value: unknown): void {
    this.state[key] = value;
  }

  /**
   * Returns a snapshot of the current state.
   */
  getSnapshot(): Record<string, unknown> {
    return { ...this.state };
  }
}
