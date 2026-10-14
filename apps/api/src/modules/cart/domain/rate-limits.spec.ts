import { Temporal } from '@mondapac/shared-kernel';
import {
  GUEST_CREATE_ORIGIN,
  GUEST_WRITE_CART,
  GUEST_WRITE_ORIGIN,
  rateVerdict,
  type RateLimit,
} from './rate-limits';

const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const at = (limit: RateLimit, count: number, started = T0) => ({
  kind: limit.kind,
  count,
  windowStartedAt: started,
});

describe('guest rate verdict', () => {
  const now = T0.add({ minutes: 5 });

  it('allows a count up to the limit and refuses the one above', () => {
    expect(rateVerdict([GUEST_WRITE_CART], [at(GUEST_WRITE_CART, 60)], now)).toEqual({
      allowed: true,
    });
    expect(rateVerdict([GUEST_WRITE_CART], [at(GUEST_WRITE_CART, 61)], now)).toEqual({
      allowed: false,
      retryAfterSeconds: 600,
    });
  });

  it('announces the longest wait when several windows refuse', () => {
    const verdict = rateVerdict(
      [GUEST_CREATE_ORIGIN, GUEST_WRITE_CART, GUEST_WRITE_ORIGIN],
      [at(GUEST_CREATE_ORIGIN, 31), at(GUEST_WRITE_CART, 61), at(GUEST_WRITE_ORIGIN, 5)],
      now,
    );

    // 60-minute window: 55 minutes left; 15-minute window: 10 minutes left.
    expect(verdict).toEqual({ allowed: false, retryAfterSeconds: 3300 });
  });

  it('announces at least one second and never passes a limit without its reservation', () => {
    const over = rateVerdict(
      [GUEST_WRITE_CART],
      [at(GUEST_WRITE_CART, 61)],
      T0.add({ minutes: 15 }),
    );
    expect(over).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(() => rateVerdict([GUEST_WRITE_CART], [], now)).toThrow();
  });
});
