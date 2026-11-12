import { err, ok } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { SubscriberContext } from '../../../../platform/events/event-subscriptions';
import type { RequestOfferReindex } from '../../application/use-cases/request-offer-reindex.use-case';
import type { SyncOfferDocuments } from '../../application/use-cases/sync-offer-documents.use-case';
import {
  cultureIndexSubscriptions,
  INDEX_ON_CATEGORY_ARCHIVED_SUBSCRIBER,
  INDEX_ON_CATEGORY_MERGED_SUBSCRIBER,
  INDEX_ON_CERTIFICATE_APPROVED_SUBSCRIBER,
  INDEX_ON_CERTIFICATE_EXPIRED_SUBSCRIBER,
  INDEX_ON_CERTIFICATE_REVOKED_SUBSCRIBER,
  INDEX_ON_CULTURE_MARK_CHANGED_SUBSCRIBER,
  INDEX_ON_CULTURE_STATUS_CHANGED_SUBSCRIBER,
  INDEX_ON_ISSUER_DEACTIVATED_SUBSCRIBER,
  INDEX_ON_SELLER_CULTURE_CHANGED_SUBSCRIBER,
  INDEX_ON_TAG_ADDED_SUBSCRIBER,
  INDEX_ON_TAG_BASIS_SWITCHED_SUBSCRIBER,
  INDEX_ON_TAG_REMOVED_SUBSCRIBER,
  INDEX_ON_TAG_RESTORED_SUBSCRIBER,
  INDEX_ON_TAG_SUSPENDED_SUBSCRIBER,
  INDEX_ON_TYPE_DEACTIVATED_SUBSCRIBER,
} from './culture-index.subscriptions';

// The wiring of search's culture_codes subscriptions (multi-culture package 3a; QA on #848): each
// event names the scope it re-syncs or asks for the full reindex, a subtree past the threshold is
// handed off, a refusal throws so the delivery is retried, and the Market context goes unchanged.

const delivery = {} as EventDelivery;
const SELLER = '01990000-0000-7000-8000-000000000051';
const OFFER = '01990000-0000-7000-8000-0000000000f1';
const CATEGORY = '01990000-0000-7000-8000-0000000000ca';
const TARGET = '01990000-0000-7000-8000-0000000000cb';
const CULTURE = '01990000-0000-7000-8000-0000000000c1';
const ISSUER = '01990000-0000-7000-8000-0000000000e1';

describe.each(['AU', 'ZZ'])('search culture subscriptions in %s', (marketId) => {
  const context = { market: { marketId } } as unknown as SubscriberContext;

  function subscriptions(options: { refuse?: boolean; handOff?: boolean } = {}) {
    const synced: unknown[] = [];
    const requested: unknown[] = [];
    const markets: string[] = [];
    const sync = {
      execute: (given: SubscriberContext, input: unknown) => {
        markets.push(given.market.marketId);
        synced.push(input);
        if (options.refuse) return Promise.resolve(err({ code: 'x' }));
        return Promise.resolve(
          ok({ upserted: 0, deleted: 0, ...(options.handOff ? { handedOff: true } : {}) }),
        );
      },
    } as unknown as SyncOfferDocuments;
    const reindex = {
      execute: (given: SubscriberContext, input: unknown) => {
        markets.push(given.market.marketId);
        requested.push(input);
        return Promise.resolve(ok({ requested: true }));
      },
    } as unknown as RequestOfferReindex;
    const all = cultureIndexSubscriptions(sync, reindex);
    const fire = (name: string, payload: object) =>
      all.find((item) => item.name === name)!.handle({ payload } as never, delivery, context);
    return { synced, requested, markets, fire, names: all.map((item) => item.name) };
  }

  it('re-syncs the seller on a membership or a seller certificate event', async () => {
    const s = subscriptions();
    for (const name of [
      INDEX_ON_SELLER_CULTURE_CHANGED_SUBSCRIBER,
      INDEX_ON_CERTIFICATE_APPROVED_SUBSCRIBER,
      INDEX_ON_CERTIFICATE_EXPIRED_SUBSCRIBER,
      INDEX_ON_CERTIFICATE_REVOKED_SUBSCRIBER,
    ]) {
      await s.fire(name, { sellerId: SELLER });
    }
    expect(s.synced).toEqual(Array.from({ length: 4 }, () => ({ sellerId: SELLER })));
    expect(s.requested).toEqual([]);
    expect(new Set(s.markets)).toEqual(new Set([marketId]));
  });

  it('re-syncs the one Offer on each tag event', async () => {
    const s = subscriptions();
    for (const name of [
      INDEX_ON_TAG_ADDED_SUBSCRIBER,
      INDEX_ON_TAG_REMOVED_SUBSCRIBER,
      INDEX_ON_TAG_SUSPENDED_SUBSCRIBER,
      INDEX_ON_TAG_RESTORED_SUBSCRIBER,
      INDEX_ON_TAG_BASIS_SWITCHED_SUBSCRIBER,
    ]) {
      await s.fire(name, { offerId: OFFER });
    }
    expect(s.synced).toEqual(Array.from({ length: 5 }, () => ({ offerIds: [OFFER] })));
  });

  it('re-syncs the subtree of a mark change, a merge (source and target) and an archive', async () => {
    const s = subscriptions();
    await s.fire(INDEX_ON_CULTURE_MARK_CHANGED_SUBSCRIBER, {
      cultureId: CULTURE,
      categoryId: CATEGORY,
    });
    await s.fire(INDEX_ON_CATEGORY_MERGED_SUBSCRIBER, {
      categoryId: CATEGORY,
      mergedIntoId: TARGET,
      checkedIds: [],
    });
    await s.fire(INDEX_ON_CATEGORY_ARCHIVED_SUBSCRIBER, { categoryId: CATEGORY, checkedIds: [] });
    expect(s.synced).toEqual([
      { categoryId: CATEGORY, handOffAbove: true },
      { categoryId: CATEGORY, handOffAbove: true },
      { categoryId: TARGET, handOffAbove: true },
      { categoryId: CATEGORY, handOffAbove: true },
    ]);
    expect(s.requested).toEqual([]);
  });

  it('asks for the full reindex when a subtree was handed off', async () => {
    const s = subscriptions({ handOff: true });
    await s.fire(INDEX_ON_CULTURE_MARK_CHANGED_SUBSCRIBER, {
      cultureId: CULTURE,
      categoryId: CATEGORY,
    });
    expect(s.requested).toEqual([{ reason: 'scope-too-large' }]);
  });

  it('asks for the full reindex on a culture status, a derecognised issuer and a deactivated type', async () => {
    const s = subscriptions();
    await s.fire(INDEX_ON_CULTURE_STATUS_CHANGED_SUBSCRIBER, {
      cultureId: CULTURE,
      status: 'inactive',
    });
    await s.fire(INDEX_ON_ISSUER_DEACTIVATED_SUBSCRIBER, {
      issuerId: ISSUER,
      form: 'derecognised',
    });
    await s.fire(INDEX_ON_ISSUER_DEACTIVATED_SUBSCRIBER, {
      issuerId: ISSUER,
      form: 'closed-to-new',
    });
    await s.fire(INDEX_ON_TYPE_DEACTIVATED_SUBSCRIBER, { typeId: ISSUER });
    expect(s.requested).toEqual([
      { reason: 'culture-status' },
      { reason: 'issuer-derecognised' },
      { reason: 'type-deactivated' },
    ]);
    expect(s.synced).toEqual([]);
  });

  it('throws on a refusal, so the delivery is retried', async () => {
    const s = subscriptions({ refuse: true });
    await expect(s.fire(INDEX_ON_TAG_ADDED_SUBSCRIBER, { offerId: OFFER })).rejects.toThrow(
      'refused: x',
    );
  });

  it('registers each subscriber name once', () => {
    const { names } = subscriptions();
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(15);
  });
});
