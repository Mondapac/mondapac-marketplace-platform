import { err, ok } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { SubscriberContext } from '../../../../platform/events/event-subscriptions';
import type { SyncOfferDocuments } from '../../application/use-cases/sync-offer-documents.use-case';
import {
  INDEX_ON_CATEGORY_CHANGED_SUBSCRIBER,
  INDEX_ON_CATEGORY_MOVED_SUBSCRIBER,
  INDEX_ON_SELLER_APPROVED_SUBSCRIBER,
  namesIndexSubscriptions,
} from './names-index.subscriptions';

// The wiring of search's name subscriptions (search 1a; QA note on #799): each event names what
// to re-sync, the approval waits for the public store, and a refusal throws so the delivery is
// retried.

const delivery = {} as EventDelivery;
const context = { market: { marketId: 'ZZ' } } as unknown as SubscriberContext;
const CATEGORY = '01990000-0000-7000-8000-0000000000ca';
const SELLER = '01990000-0000-7000-8000-000000000051';

function subscriptions(refuse = false) {
  const seen: unknown[] = [];
  const sync = {
    execute: (_context: unknown, input: unknown) => {
      seen.push(input);
      return Promise.resolve(refuse ? err({ code: 'x' }) : ok({ upserted: 0, deleted: 0 }));
    },
  } as unknown as SyncOfferDocuments;
  const all = namesIndexSubscriptions(sync);
  return { seen, named: (name: string) => all.find((item) => item.name === name)! };
}

describe('search name subscriptions', () => {
  it('re-syncs the documents of a changed or moved category', async () => {
    const { seen, named } = subscriptions();
    await named(INDEX_ON_CATEGORY_CHANGED_SUBSCRIBER).handle(
      { payload: { categoryId: CATEGORY } } as never,
      delivery,
      context,
    );
    await named(INDEX_ON_CATEGORY_MOVED_SUBSCRIBER).handle(
      { payload: { categoryId: CATEGORY, checkedIds: [] } } as never,
      delivery,
      context,
    );

    expect(seen).toEqual([{ categoryId: CATEGORY }, { categoryId: CATEGORY }]);
  });

  it("re-syncs an approved seller's Offers once sellers shows the public store", async () => {
    const { seen, named } = subscriptions();
    await named(INDEX_ON_SELLER_APPROVED_SUBSCRIBER).handle(
      { payload: { sellerId: SELLER } } as never,
      delivery,
      context,
    );

    expect(seen).toEqual([{ sellerId: SELLER, publicStoreRequired: true }]);
  });

  it('throws on a refusal, so the delivery is retried', async () => {
    const { named } = subscriptions(true);

    await expect(
      named(INDEX_ON_SELLER_APPROVED_SUBSCRIBER).handle(
        { payload: { sellerId: SELLER } } as never,
        delivery,
        context,
      ),
    ).rejects.toThrow('refused: x');
  });
});
