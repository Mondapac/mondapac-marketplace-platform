import { Temporal } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { BREAKER_FAILURES, BREAKER_OPEN_FOR, CircuitBreaker } from './circuit-breaker';

describe('CircuitBreaker (design section 6)', () => {
  const ROUTE = 'anthropic-api/m';
  let clock: FixedClock;
  let breaker: CircuitBreaker;
  beforeEach(() => {
    clock = new FixedClock(Temporal.Instant.from('2026-11-25T10:00:00Z'));
    breaker = new CircuitBreaker(clock);
  });

  it(`sets a route aside after ${BREAKER_FAILURES} failures in a row, per Market`, () => {
    for (let index = 1; index < BREAKER_FAILURES; index += 1) {
      expect(breaker.failed('AU', ROUTE)).toBe(false);
    }
    expect(breaker.failed('AU', ROUTE)).toBe(true);
    expect(breaker.allow('AU', ROUTE)).toBe(false);
    expect(breaker.allow('ZZ', ROUTE)).toBe(true);
  });

  it('a success clears the count', () => {
    breaker.failed('AU', ROUTE);
    breaker.failed('AU', ROUTE);
    breaker.succeeded('AU', ROUTE);
    expect(breaker.failed('AU', ROUTE)).toBe(false);
  });

  it('lets one trial through after the pause; a failed trial sets it aside again', () => {
    for (let index = 0; index < BREAKER_FAILURES; index += 1) breaker.failed('AU', ROUTE);
    clock.advance(BREAKER_OPEN_FOR);
    expect(breaker.allow('AU', ROUTE)).toBe(true);
    expect(breaker.allow('AU', ROUTE)).toBe(false);
    expect(breaker.failed('AU', ROUTE)).toBe(true);
    expect(breaker.allow('AU', ROUTE)).toBe(false);
    clock.advance(BREAKER_OPEN_FOR);
    expect(breaker.allow('AU', ROUTE)).toBe(true);
    breaker.succeeded('AU', ROUTE);
    expect(breaker.open('AU', ROUTE)).toBe(false);
  });

  it('frees a trial that never reported after another pause', () => {
    for (let index = 0; index < BREAKER_FAILURES; index += 1) breaker.failed('AU', ROUTE);
    clock.advance(BREAKER_OPEN_FOR);
    expect(breaker.allow('AU', ROUTE)).toBe(true);
    clock.advance(BREAKER_OPEN_FOR);
    expect(breaker.allow('AU', ROUTE)).toBe(true);
  });
});
