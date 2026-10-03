// Fakes and test builders: the `@mondapac/shared-kernel/testing` entry. Tests only: nothing
// here may be bound in a running process, and nothing here is exported from the main entry.
import { uuidV7 } from './id';
import type { Id, IdGenerator } from './id';
import { mintMarketContext, parseMarketId, parseTenantId } from './market-context';
import type { MarketContext } from './market-context';
import { Temporal } from './time';
import type { Clock } from './time';

const toMillisecond = (instant: Temporal.Instant): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(instant.epochMilliseconds);

/**
 * A clock that never ticks by itself: `now()` returns the same instant until the test calls
 * `advance()` or `set()`. Like every Clock it returns instants truncated to the millisecond.
 */
export class FixedClock implements Clock {
  private current: Temporal.Instant;

  constructor(start: Temporal.Instant) {
    this.current = toMillisecond(start);
  }

  now(): Temporal.Instant {
    return this.current;
  }

  advance(duration: Temporal.Duration): void {
    this.current = toMillisecond(this.current.add(duration));
  }

  set(instant: Temporal.Instant): void {
    this.current = toMillisecond(instant);
  }
}

/**
 * Valid version 7 ids that a test can predict: the clock's time and a counter in place of
 * the random bytes. The counter starts at 1 and never resets, so the ids of one generator
 * are unique and rise as long as its clock does not go back.
 */
export class SequenceIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly clock: Clock) {}

  next<K extends string>(): Id<K> {
    this.counter += 1;

    // The counter fills the low 6 of the 10 bytes; the layout uses every bit of those.
    const bytes = new Uint8Array(10);
    let rest = this.counter;
    for (let index = bytes.length - 1; index >= 4; index -= 1) {
      bytes[index] = rest % 256;
      rest = Math.floor(rest / 256);
    }

    return uuidV7(this.clock.now().epochMilliseconds, bytes) as Id<K>;
  }
}

/**
 * A minted MarketContext for a test. Both identifiers are explicit (a test has no default
 * Market either), are parsed first and go through the same mint function as production.
 */
export function testMarketContext(marketId: string, tenantId: string): MarketContext {
  const market = parseMarketId(marketId);
  if (!market.ok) throw new Error(`testMarketContext: malformed market id "${marketId}"`);
  const tenant = parseTenantId(tenantId);
  if (!tenant.ok) throw new Error(`testMarketContext: malformed tenant id "${tenantId}"`);

  return mintMarketContext(market.value, tenant.value);
}
