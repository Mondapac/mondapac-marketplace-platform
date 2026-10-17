import type { CallContext } from '@mondapac/shared-kernel';
import {
  SequenceIdGenerator,
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { Temporal } from '@mondapac/shared-kernel';
import { reviewerOf } from './review.shared';

// The one place every review use case decides who may call: the admin population, and for a write
// not an acting-as (Login as Seller) session. Every write use case calls it with `write: true`.

describe.each(['AU', 'ZZ'] as const)('reviewerOf, Market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const ids = new SequenceIdGenerator(
    new FixedClock(Temporal.Instant.from('2026-10-17T00:00:00Z')),
  );
  const contextOf = (
    population: 'admin' | 'seller' | 'customer',
    actingAs = false,
  ): CallContext => {
    const actor = testAuthenticatedActor(market, {
      population,
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId: population === 'seller' ? ids.next<'Seller'>() : null,
    });
    const marked = actingAs ? { ...actor, actingAs: { accountId: 'x', sellerId: 'y' } } : actor;
    return { ...testCallContext(market, actor), actor: marked };
  };

  it('admits an admin to reads and writes', () => {
    expect(reviewerOf(contextOf('admin'), { write: false })).not.toBeNull();
    expect(reviewerOf(contextOf('admin'), { write: true })).not.toBeNull();
  });

  it('refuses an acting-as session for a write only', () => {
    expect(reviewerOf(contextOf('admin', true), { write: true })).toBeNull();
    expect(reviewerOf(contextOf('admin', true), { write: false })).not.toBeNull();
  });

  it.each(['seller', 'customer'] as const)('refuses a %s account', (population) => {
    expect(reviewerOf(contextOf(population), { write: false })).toBeNull();
    expect(reviewerOf(contextOf(population), { write: true })).toBeNull();
  });

  it('refuses anonymous and system callers', () => {
    expect(reviewerOf(testCallContext(market, 'anonymous'), { write: false })).toBeNull();
    expect(reviewerOf(testCallContext(market, 'system'), { write: false })).toBeNull();
  });
});
