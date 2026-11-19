import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { SellersFacade } from '../../sellers';
import { SellersSellerNames } from './sellers-seller-names';

// The payments adapter on the sellers facade: the store names in calls of at most 100 ids, the
// whole answer `unavailable` when one call fails, and a failed search that never carries its term.

const sellerId = (n: number): Id<'Seller'> => {
  const parsed = parseId<'Seller'>(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};

describe.each(['AU', 'ZZ'])('SellersSellerNames in market %s', (code) => {
  const context: CallContext = testCallContext(
    testMarketContext(code, 'default'),
    'system',
    'names-abcd',
  );
  const calls: number[] = [];
  let failOn: number | null = null;
  let searchFails = false;
  const facade = {
    sellerSummaries: (_context: CallContext, ids: readonly Id<'Seller'>[]) => {
      calls.push(ids.length);
      if (failOn === calls.length) return Promise.resolve(err({ code: 'sellers.unavailable' }));
      return Promise.resolve(
        ok(ids.map((id) => ({ sellerId: id, exists: true, storeName: `Store ${id.slice(-3)}` }))),
      );
    },
    searchStoreNames: () =>
      Promise.resolve(
        searchFails
          ? err({ code: 'sellers.unavailable' })
          : ok({ sellerIds: [sellerId(1)], capped: true }),
      ),
  } as unknown as SellersFacade;
  const names = new SellersSellerNames(facade);

  beforeEach(() => {
    calls.length = 0;
    failOn = null;
    searchFails = false;
  });

  it('reads the names in calls of at most 100 ids', async () => {
    const ids = Array.from({ length: 250 }, (_, n) => sellerId(n + 1));
    const answer = await names.storeNames(context, ids);
    expect(calls).toEqual([100, 100, 50]);
    expect(answer !== 'unavailable' && answer.size).toBe(250);
    expect(answer !== 'unavailable' && answer.get(sellerId(250))).toBe('Store 0fa');
    expect(await names.storeNames(context, [])).toEqual(new Map());
  });

  it('answers unavailable when any call fails', async () => {
    failOn = 2;
    const ids = Array.from({ length: 150 }, (_, n) => sellerId(n + 1));
    expect(await names.storeNames(context, ids)).toBe('unavailable');
  });

  it('passes the capped flag on, and throws without the term when the search fails', async () => {
    expect(await names.storesMatching(context, 'corner')).toEqual({
      sellerIds: [sellerId(1)],
      capped: true,
    });
    searchFails = true;
    const thrown = await names.storesMatching(context, 'secret term').catch((e: Error) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('sellers.searchStoreNames: sellers.unavailable');
    expect((thrown as Error).message).not.toContain('secret');
  });
});
