import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { activeTagState } from '../../../../../test/support/catalog-tag-fakes';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { Offer, type OfferState } from '../../domain/offer';
import type { OfferTagState } from '../../domain/offer-tag';
import type { OfferRepository } from '../ports/offer.repository';
import { markRechecking } from './reask-offers';

// Hassan L-1 (PR #398): the marking of an ending certificate's tags runs one unit per Offer, so a
// lost race on one Offer never rolls back the marks of the others; a lost race is tried once more
// on a fresh read. Both Market fixtures.

const T0 = Temporal.Instant.from('2026-10-17T00:00:00Z');

describe.each([
  ['AU', 'halal'],
  ['ZZ', 'zz-cert'],
] as const)('markRechecking in market %s', (code, typeCode) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const certificate = {
    certificateId: ids.next(),
    versionId: ids.next(),
    typeRevisionId: ids.next(),
  };

  const offerState = (): OfferState => ({
    id: ids.next<'Offer'>(),
    marketId: code as MarketId,
    sellerId: ids.next<'Seller'>(),
    productId: ids.next<'Product'>(),
    sellerSku: 'SKU-1',
    conditionCode: 'new',
    description: {},
    handling: 'SEALED_ORIGINAL',
    attestationRecordedAt: null,
    attestationAccountId: null,
    status: 'published',
    offSaleCauses: [],
    listed: true,
    submittedAt: T0,
    firstPublishedAt: T0,
    deletedAt: null,
    version: 3,
    createdAt: T0,
  });

  /** Offers with one active tag each; `staleSaves` counts the lost races left per Offer. */
  function rig(staleSaves: readonly number[]) {
    const rows = new Map<string, { state: OfferState; tags: readonly OfferTagState[] }>();
    const left = new Map<string, number>();
    const offerIds = staleSaves.map((stale) => {
      const state = offerState();
      rows.set(state.id, {
        state,
        tags: [activeTagState(ids.next<'OfferTag'>(), typeCode, certificate, T0)],
      });
      left.set(state.id, stale);
      return state.id;
    });
    const committed: string[] = [];
    let pending: string[] = [];
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => {
        pending = [];
        const result = await work();
        committed.push(...pending);
        return result;
      },
    } as unknown as UnitOfWork;
    const offers = {
      findById: (_m: MarketContext, id: Id<'Offer'>) => {
        const row = rows.get(id);
        return Promise.resolve(row === undefined ? null : Offer.restore(row.state, row.tags));
      },
      save: (_m: MarketContext, offer: Offer) => {
        const stale = left.get(offer.state.id) ?? 0;
        if (stale > 0) {
          left.set(offer.state.id, stale - 1);
          return Promise.reject(new StaleAggregateError('Offer', offer.state.id));
        }
        rows.set(offer.state.id, { state: offer.state, tags: offer.tags });
        pending.push(offer.state.id);
        return Promise.resolve();
      },
    } as unknown as OfferRepository;
    const statusOf = (id: string) => rows.get(id)!.tags[0]!.status;
    return { offerIds, unitOfWork, offers, committed, statusOf };
  }

  const options = {
    entryPath: 'certification-event' as const,
    causeEventId: null,
    selects: () => true,
  };

  it('marks every Offer in its own unit; one Offer lost twice leaves the others marked', async () => {
    const { offerIds, unitOfWork, offers, committed, statusOf } = rig([0, 2, 0]);
    const marked = await markRechecking(
      { unitOfWork, offers, clock },
      testCallContext(market, 'system'),
      offerIds,
      options,
    );
    expect(marked).toBe(2);
    expect(committed).toEqual([offerIds[0], offerIds[2]]);
    expect(offerIds.map(statusOf)).toEqual(['rechecking', 'active', 'rechecking']);
  });

  it('marks an Offer on a fresh read after one lost race', async () => {
    const { offerIds, unitOfWork, offers, statusOf } = rig([1]);
    expect(
      await markRechecking(
        { unitOfWork, offers, clock },
        testCallContext(market, 'system'),
        offerIds,
        options,
      ),
    ).toBe(1);
    expect(statusOf(offerIds[0]!)).toBe('rechecking');
  });
});
