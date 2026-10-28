import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { FakeShipping } from '../../../../test/support/ordering-fakes';
import { DELIVERY_METHODS as ORDERING_METHODS } from '../domain/delivery-method';
import { DELIVERY_METHODS as SHIPPING_METHODS } from '../../shipping';
import { ShippingDeliveryMethodPolicy } from './shipping-delivery-method-policy';

// The real policy of ordering is shipping's delivery choice behind the existing seam: it passes
// the method and the window through, and anything but a clear yes is a no.

const SELLER = '01990000-0000-7000-8000-000000000051' as Id<'Seller'>;

describe.each([['AU'], ['ZZ']] as const)('ShippingDeliveryMethodPolicy in market %s', (code) => {
  const context = testCallContext(testMarketContext(code, 'default'), 'anonymous');
  let shipping: FakeShipping;
  let policy: ShippingDeliveryMethodPolicy;

  beforeEach(() => {
    shipping = new FakeShipping();
    policy = new ShippingDeliveryMethodPolicy(shipping);
  });

  it('keeps the list of methods equal to shipping list (the wire values are shared)', () => {
    expect([...ORDERING_METHODS]).toEqual([...SHIPPING_METHODS]);
  });

  it('allows what shipping allows and passes the method on', async () => {
    expect(await policy.allows(context, SELLER, 'instant')).toBe(true);
    expect(shipping.deliveryChoicesAsked).toEqual([
      { sellerId: SELLER, method: 'instant', window: null },
    ]);
  });

  it('passes the scheduled window as ISO instants', async () => {
    const start = Temporal.Instant.from('2026-06-12T04:00:00Z');
    const end = Temporal.Instant.from('2026-06-12T06:00:00Z');
    expect(await policy.allows(context, SELLER, 'scheduled', { start, end })).toBe(true);
    expect(shipping.deliveryChoicesAsked[0]?.window).toEqual({
      start: '2026-06-12T04:00:00Z',
      end: '2026-06-12T06:00:00Z',
    });
  });

  it('refuses what shipping refuses', async () => {
    shipping.deliveryRefused.set(`${SELLER}|same_day`, 'past-cut-off');
    expect(await policy.allows(context, SELLER, 'same_day')).toBe(false);
    expect(await policy.allows(context, SELLER, 'pickup')).toBe(true);
  });

  it('refuses when shipping cannot answer (fail closed)', async () => {
    shipping.deliveryChoiceDown = true;
    expect(await policy.allows(context, SELLER, 'instant')).toBe(false);
  });

  it('refuses when the call throws', async () => {
    shipping.deliveryChoice = () => Promise.reject(new Error('boom'));
    expect(await policy.allows(context, SELLER, 'instant')).toBe(false);
  });
});
