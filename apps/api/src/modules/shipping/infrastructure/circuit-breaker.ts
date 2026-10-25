import type { Clock } from '@mondapac/shared-kernel';

export interface CircuitBreakerSettings {
  /** Consecutive failed calls that open the circuit. */
  readonly failureThreshold: number;
  /** How long an open circuit refuses calls before one trial call is let through. */
  readonly cooldownMs: number;
}

interface Circuit {
  failures: number;
  /** Epoch milliseconds until which calls are refused; null while closed. */
  openUntil: number | null;
  /** A trial call is out after the cooldown: others are refused until it settles. */
  trialOut: boolean;
}

/**
 * A per-key circuit breaker (one key per Market's carrier endpoint), in process memory: after
 * `failureThreshold` failures in a row it opens and every call fails fast for `cooldownMs`; then
 * one trial call goes through (half-open). A success closes it, a failure opens it again. Time
 * comes from the injected Clock. Each API process keeps its own circuits, which is enough to stop
 * a stack from piling requests on a carrier that is down.
 */
export class CircuitBreaker {
  readonly #circuits = new Map<string, Circuit>();

  constructor(private readonly clock: Clock) {}

  /** Whether a call may go out now; a true answer after the cooldown is the one trial. */
  allow(key: string): boolean {
    const circuit = this.#circuits.get(key);
    if (circuit === undefined || circuit.openUntil === null) return true;
    if (this.clock.now().epochMilliseconds < circuit.openUntil || circuit.trialOut) return false;
    circuit.trialOut = true;
    return true;
  }

  succeeded(key: string): void {
    this.#circuits.delete(key);
  }

  failed(key: string, settings: CircuitBreakerSettings): void {
    const circuit = this.#circuits.get(key) ?? { failures: 0, openUntil: null, trialOut: false };
    circuit.failures += 1;
    if (circuit.trialOut || circuit.failures >= settings.failureThreshold) {
      circuit.openUntil = this.clock.now().epochMilliseconds + settings.cooldownMs;
      circuit.trialOut = false;
    }
    this.#circuits.set(key, circuit);
  }

  /** `closed`, `open` or `half-open`, for tests and diagnostics. */
  state(key: string): 'closed' | 'open' | 'half-open' {
    const circuit = this.#circuits.get(key);
    if (circuit === undefined || circuit.openUntil === null) return 'closed';
    return this.clock.now().epochMilliseconds < circuit.openUntil ? 'open' : 'half-open';
  }
}
