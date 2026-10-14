import { Temporal } from '@mondapac/shared-kernel';

import {
  PRICE_WRITE_LIMITS,
  writeRateVerdict,
  writeWindowRestartBefore,
  type WriteRateReservation,
} from './write-rate-limits';

const t0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const reservation = (
  kind: WriteRateReservation['kind'],
  count: number,
  windowStartedAt = t0,
): WriteRateReservation => ({ kind, count, windowStartedAt });

describe('writeRateVerdict', () => {
  it('allows exactly the limit of each window and refuses one attempt more', () => {
    const atLimit = [
      reservation('write.account.day', 1000),
      reservation('write.account.minute', 60),
    ];
    expect(writeRateVerdict(PRICE_WRITE_LIMITS, atLimit, t0)).toEqual({ allowed: true });
    const overMinute = [
      reservation('write.account.day', 61),
      reservation('write.account.minute', 61),
    ];
    expect(writeRateVerdict(PRICE_WRITE_LIMITS, overMinute, t0.add({ seconds: 20 }))).toEqual({
      allowed: false,
      retryAfterSeconds: 40,
    });
  });

  it('refuses the 1001st attempt of a day and waits for the rest of the day window', () => {
    const over = [reservation('write.account.day', 1001), reservation('write.account.minute', 1)];
    const now = t0.add({ hours: 20 });
    expect(writeRateVerdict(PRICE_WRITE_LIMITS, over, now)).toEqual({
      allowed: false,
      retryAfterSeconds: 4 * 3600,
    });
  });

  it('announces the longest rest when both windows refuse', () => {
    const both = [reservation('write.account.day', 1500), reservation('write.account.minute', 90)];
    expect(writeRateVerdict(PRICE_WRITE_LIMITS, both, t0.add({ seconds: 30 }))).toEqual({
      allowed: false,
      retryAfterSeconds: 24 * 3600 - 30,
    });
  });

  it('announces at least one second, even when the window ends in this instant', () => {
    const over = [reservation('write.account.day', 1), reservation('write.account.minute', 61)];
    expect(writeRateVerdict(PRICE_WRITE_LIMITS, over, t0.add({ minutes: 1 }))).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
  });

  it('throws when a limit has no reservation, never a pass', () => {
    expect(() =>
      writeRateVerdict(PRICE_WRITE_LIMITS, [reservation('write.account.day', 1)], t0),
    ).toThrow('no reservation of write.account.minute');
  });
});

describe('writeWindowRestartBefore', () => {
  it('is one window length before now, per limit', () => {
    const now = t0.add({ hours: 30 });
    const [day, minute] = PRICE_WRITE_LIMITS;
    expect(writeWindowRestartBefore(day!, now).toString()).toBe(
      now.subtract({ hours: 24 }).toString(),
    );
    expect(writeWindowRestartBefore(minute!, now).toString()).toBe(
      now.subtract({ minutes: 1 }).toString(),
    );
  });
});
