/**
 * The model rounds of each user turn (docs/design/domain/platform-ai.md section 5;
 * `CapabilitySpec.maxToolRounds`): one `run` is one round, and a capability with tools allows
 * `maxToolRounds` runs per turn; one without tools allows one. A turn lives in one request on one
 * API instance, so the count is kept in memory, keyed by capability and the caller's turn id, and
 * forgotten after {@link TURN_MEMORY_MS}. It is defence in depth against a runaway tool loop in a
 * module, which keeps its own cap as well.
 */
export const TURN_MEMORY_MS = 10 * 60_000;
/** The most turns remembered at once; the oldest are dropped first. */
export const MAX_TURNS_REMEMBERED = 10_000;

/** A caller's turn id: 1 to 100 of A-Z a-z 0-9 . _ : - */
export const TURN_ID = /^[A-Za-z0-9._:-]{1,100}$/;

export class TurnRounds {
  readonly #turns = new Map<string, { count: number; until: number }>();

  constructor(private readonly nowMs: () => number = () => performance.now()) {}

  /** Counts one round of the turn; false when the turn has used all `allowed` rounds. */
  take(capability: string, turnId: string, allowed: number): boolean {
    const now = this.nowMs();
    this.#forget(now);
    const key = `${capability}|${turnId}`;
    const turn = this.#turns.get(key);
    if (turn === undefined) {
      if (this.#turns.size >= MAX_TURNS_REMEMBERED) {
        const oldest = this.#turns.keys().next().value;
        if (oldest !== undefined) this.#turns.delete(oldest);
      }
      this.#turns.set(key, { count: 1, until: now + TURN_MEMORY_MS });
      return allowed >= 1;
    }
    if (turn.count >= allowed) return false;
    turn.count += 1;
    return true;
  }

  /** Map order is insertion order, so expired turns are at the front. */
  #forget(now: number): void {
    for (const [key, turn] of this.#turns) {
      if (turn.until > now) return;
      this.#turns.delete(key);
    }
  }
}
