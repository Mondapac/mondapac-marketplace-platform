import { Temporal } from '@mondapac/shared-kernel';
import type { Clock, MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type {
  AdminActionLimits,
  AdminActionLimitSettings,
  AdminLimitedAction,
} from '../ports/admin-action-limits';

const WINDOW = Temporal.Duration.from({ hours: 1 });

/**
 * {@link AdminActionLimits} in memory, on the injected clock: one fixed one-hour window per action
 * and subject, starting at its first attempt (as the shared counters do), and the Market's limits
 * from the configuration. `failing` makes the next counts reject (a counter that cannot be read).
 */
export class MemoryAdminActionLimits implements AdminActionLimits {
  readonly #windows = new Map<string, { start: Temporal.Instant; count: number }>();
  /** Every subject counted, in order, with its action. */
  readonly counted: { readonly action: AdminLimitedAction; readonly subject: string }[] = [];
  failing = false;

  constructor(
    private readonly markets: MarketRegistry,
    private readonly clock: Clock,
  ) {}

  settings(market: MarketContext): AdminActionLimitSettings | null {
    return this.markets.get(market.marketId).customers?.adminActionLimits ?? null;
  }

  count(action: AdminLimitedAction, subject: string) {
    if (this.failing) return Promise.reject(new Error('counter unavailable'));
    this.counted.push({ action, subject });
    const now = this.clock.now();
    const key = `${action}|${subject}`;
    let window = this.#windows.get(key);
    if (window === undefined || Temporal.Instant.compare(now, window.start.add(WINDOW)) >= 0) {
      window = { start: now, count: 0 };
      this.#windows.set(key, window);
    }
    window.count += 1;
    const left = window.start.add(WINDOW).since(now).total({ unit: 'seconds' });
    return Promise.resolve({
      count: window.count,
      retryAfterSeconds: Math.max(1, Math.ceil(left)),
    });
  }
}
