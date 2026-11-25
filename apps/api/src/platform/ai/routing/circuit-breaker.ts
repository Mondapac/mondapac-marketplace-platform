import { Temporal } from '@mondapac/shared-kernel';
import type { Clock } from '@mondapac/shared-kernel';

/** Failures in a row that set a route aside (design section 6, "Circuit breaker"). */
export const BREAKER_FAILURES = 3;
/** How long a route is set aside; then one call may try it again. */
export const BREAKER_OPEN_FOR = Temporal.Duration.from({ minutes: 2 });

interface RouteState {
  failures: number;
  openUntil: Temporal.Instant | null;
  /** When the one trial call after the pause went out; a trial never reported ends after a pause. */
  trialAt: Temporal.Instant | null;
}

/**
 * The circuit breaker of the routes, per Market and route row, in the memory of one API instance.
 * After {@link BREAKER_FAILURES} failures in a row (an outage, a timeout, a server error or a rate
 * limit, never a refusal), the route is set aside for {@link BREAKER_OPEN_FOR} and calls go
 * straight to the next route. Then one call tries it again: a success closes it, a failure sets it
 * aside again. Each instance learns on its own; nothing is shared or stored.
 */
export class CircuitBreaker {
  readonly #states = new Map<string, RouteState>();

  constructor(private readonly clock: Clock) {}

  /**
   * Whether a call may use the route now; takes the trial call when the pause is over. Ask it only
   * right before the call is sent, so a taken trial is always reported (Mohammad, G3 review 4).
   */
  allow(marketId: string, routeId: string): boolean {
    if (!this.ready(marketId, routeId)) return false;
    const state = this.#states.get(keyOf(marketId, routeId));
    if (state !== undefined && state.openUntil !== null) state.trialAt = this.clock.now();
    return true;
  }

  /** Whether {@link allow} would let a call through now, without taking the trial call. */
  ready(marketId: string, routeId: string): boolean {
    const state = this.#states.get(keyOf(marketId, routeId));
    if (state === undefined || state.openUntil === null) return true;
    const now = this.clock.now();
    if (Temporal.Instant.compare(now, state.openUntil) < 0) return false;
    return (
      state.trialAt === null ||
      Temporal.Instant.compare(now, state.trialAt.add(BREAKER_OPEN_FOR)) >= 0
    );
  }

  /** Whether the route is set aside now (for the monitoring page), without taking a trial. */
  open(marketId: string, routeId: string): boolean {
    const state = this.#states.get(keyOf(marketId, routeId));
    return (
      state !== undefined &&
      state.openUntil !== null &&
      (Temporal.Instant.compare(this.clock.now(), state.openUntil) < 0 || state.trialAt !== null)
    );
  }

  succeeded(marketId: string, routeId: string): void {
    this.#states.delete(keyOf(marketId, routeId));
  }

  /** Answers whether this failure set the route aside (it is logged once, by the gateway). */
  failed(marketId: string, routeId: string): boolean {
    const key = keyOf(marketId, routeId);
    const state = this.#states.get(key) ?? { failures: 0, openUntil: null, trialAt: null };
    state.failures += 1;
    const opens = state.trialAt !== null || state.failures >= BREAKER_FAILURES;
    if (opens) {
      state.openUntil = this.clock.now().add(BREAKER_OPEN_FOR);
      state.trialAt = null;
      state.failures = 0;
    }
    this.#states.set(key, state);
    return opens;
  }
}

const keyOf = (marketId: string, routeId: string) => `${marketId}|${routeId}`;
