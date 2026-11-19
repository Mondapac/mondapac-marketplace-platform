import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeShipping } from '../../../../test/support/ordering-fakes';
import { FacadeCarrierProgressReader } from './facade-carrier-progress.reader';

// The carrier progress adapter over shipping's facade on both Market fixtures: one call with the
// distinct ids, the five fields mapped as they are, an id shipping did not get asked about
// ignored, `access.denied` answered as "not available", and every other refusal thrown.

const T0 = Temporal.Instant.from('2026-11-16T09:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SO1 = id<'SellerOrder'>(0x501);
const SO2 = id<'SellerOrder'>(0x502);
const EXTRA = id<'SellerOrder'>(0x5ff);

describe.each(['AU', 'ZZ'] as const)('carrier progress through the facade in market %s', (code) => {
  // The caller is an admin, as on the Shipments list (shipping checks its own key).
  const market = testMarketContext(code, 'default');
  const context = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: id<'Account'>(0x601),
      sessionId: id<'Session'>(0x602),
      sellerId: null,
    }),
  );
  const view = {
    fleet: 'doordash_drive',
    progress: 'delivered' as const,
    carrierStatus: 'DELIVERED',
    updatedAt: T0,
    proofOfDelivery: true,
  };

  it('asks once with distinct ids, maps the five fields and ignores an id not asked', async () => {
    const shipping = new FakeShipping();
    shipping.carrierProgress.set(SO1, view);
    shipping.carrierProgress.set(EXTRA, { ...view, progress: 'exception' });

    const answer = await new FacadeCarrierProgressReader(shipping).progressOf(context, [
      SO1,
      SO2,
      SO1,
    ]);

    expect(shipping.carrierProgressAsked).toEqual([[SO1, SO2]]);
    expect(answer.available).toBe(true);
    expect([...answer.progress.entries()]).toEqual([
      [
        SO1,
        {
          progress: 'delivered',
          carrierStatus: 'DELIVERED',
          updatedAt: T0,
          proofOfDelivery: true,
          fleet: 'doordash_drive',
        },
      ],
    ]);
  });

  it('answers not available, with nothing, for an admin without the key, and a new answer each time', async () => {
    const shipping = new FakeShipping();
    shipping.carrierProgress.set(SO1, view);
    shipping.carrierProgressRefusal = 'access.denied';
    const answer = await new FacadeCarrierProgressReader(shipping).progressOf(context, [SO1]);
    expect(answer.available).toBe(false);
    expect(answer.progress.size).toBe(0);
    const again = await new FacadeCarrierProgressReader(shipping).progressOf(context, [SO1]);
    expect(again.progress).not.toBe(answer.progress);
  });

  it('throws on every other refusal (the list then shows no progress)', async () => {
    for (const refusal of ['validation.failed', 'shipping.unavailable'] as const) {
      const shipping = new FakeShipping();
      shipping.carrierProgressRefusal = refusal;
      await expect(
        new FacadeCarrierProgressReader(shipping).progressOf(context, [SO1]),
      ).rejects.toThrow(`shipping.carrierProgressOf: ${refusal}`);
    }
  });

  it('asks nothing for no ids', async () => {
    const shipping = new FakeShipping();
    const answer = await new FacadeCarrierProgressReader(shipping).progressOf(context, []);
    expect(answer).toEqual({ available: true, progress: new Map() });
    expect(shipping.carrierProgressAsked).toEqual([]);
  });
});
