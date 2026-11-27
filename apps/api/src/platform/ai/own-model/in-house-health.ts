import { Inject, Injectable, type BeforeApplicationShutdown } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { Clock, MarketId } from '@mondapac/shared-kernel';
import { CLOCK } from '../../clock/clock.module';
import type { RouteRow } from '../catalogue/route-catalogue';
import { ModelGateway } from '../model-gateway';

/** How long a health answer stands: older, the row is not healthy until a new one comes. */
export const HEALTH_FRESH_FOR = Temporal.Duration.from({ seconds: 60 });
/** From this age a new check is started in the background, so a healthy row stays fresh. */
export const HEALTH_REFRESH_AFTER = Temporal.Duration.from({ seconds: 30 });
/** The most one health check waits for the answer. */
export const HEALTH_CHECK_TIMEOUT_MS = 5_000;

interface HealthState {
  healthy: boolean;
  checkedAt: Temporal.Instant;
}

/**
 * The in-house route's health (AI Gateway G6d1; FE-20261126-ai-gateway-in-house-health-check;
 * docs/design/domain/platform-ai.md section 8, "In-house route readiness"): whether a row of the
 * in-house model serves its exact model version now, by the contract's `GET /v1/health`, per
 * Market and row, in the memory of one API instance like the circuit breaker.
 *
 * {@link healthy} never waits: it answers from the last check and, when that is missing or older
 * than {@link HEALTH_REFRESH_AFTER}, starts one check in the background (one at a time per Market
 * and row). A row is healthy only with a check that said so less than {@link HEALTH_FRESH_FOR} ago:
 * no answer yet, an old answer, a failure, a timeout or another version is not healthy (fail
 * closed). G6d routes a live (percent or default) call to the in-house model only through a healthy
 * row, so a mismatch or an outage is found without a caller's request reaching it and without
 * budget; the panel (G6e) may show the same answer. Shadow calls do not need it: their answer
 * reaches no one, and their failures are measured.
 */
@Injectable()
export class InHouseHealth implements BeforeApplicationShutdown {
  readonly #states = new Map<string, HealthState>();
  readonly #running = new Map<string, Promise<void>>();
  #closing = false;

  constructor(
    private readonly models: ModelGateway,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Whether the row is healthy now (see the class); may start a check. Never throws. */
  healthy(marketId: MarketId, row: RouteRow): boolean {
    try {
      const key = keyOf(marketId, row.id);
      const state = this.#states.get(key);
      const now = this.clock.now();
      const age = (at: Temporal.Instant) => now.since(at);
      if (
        state === undefined ||
        Temporal.Duration.compare(age(state.checkedAt), HEALTH_REFRESH_AFTER) >= 0
      ) {
        this.#check(marketId, row, key);
      }
      return (
        state !== undefined &&
        state.healthy &&
        Temporal.Duration.compare(age(state.checkedAt), HEALTH_FRESH_FOR) < 0
      );
    } catch {
      return false;
    }
  }

  #check(marketId: MarketId, row: RouteRow, key: string): void {
    if (this.#closing || this.#running.has(key)) return;
    const running = this.models
      .healthy(marketId, row, HEALTH_CHECK_TIMEOUT_MS)
      .catch(() => false)
      .then((healthy) => {
        this.#states.set(key, { healthy, checkedAt: this.clock.now() });
      })
      .finally(() => {
        this.#running.delete(key);
      });
    this.#running.set(key, running);
  }

  /** Waits for every check started so far (tests, and shutdown). */
  async settled(): Promise<void> {
    while (this.#running.size > 0) await Promise.all([...this.#running.values()]);
  }

  /** On close no new check starts; the ones out end (each is cut at its timeout). */
  async beforeApplicationShutdown(): Promise<void> {
    this.#closing = true;
    await this.settled();
  }
}

const keyOf = (marketId: string, rowId: string) => `${marketId}|${rowId}`;
