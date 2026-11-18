import type { ActorContext } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { isPlatformAdminActor } from './platform-admin';

// The one platform-admin check of the admin reads (security review of #969, I3), in both Market
// fixtures: only an authenticated admin with no seller and no acting-as marker.

const ID = '01990000-0000-7000-8000-000000000001';
const SESSION = '01990000-0000-7000-8000-000000000002';
const SELLER = '01990000-0000-7000-8000-000000000003';

describe.each(['AU', 'ZZ'] as const)('isPlatformAdminActor in %s', (code) => {
  const market = testMarketContext(code, 'default');
  const actor = (population: 'admin' | 'seller' | 'customer'): ActorContext =>
    testAuthenticatedActor(market, {
      population,
      accountId: ID as never,
      sessionId: SESSION as never,
      sellerId: population === 'seller' ? (SELLER as never) : null,
    });

  it('accepts an admin on an admin session', () => {
    expect(isPlatformAdminActor(actor('admin'))).toBe(true);
    expect(isPlatformAdminActor({ ...actor('admin'), actingAs: null } as never)).toBe(true);
  });

  it('refuses every other actor, and an admin acting as someone', () => {
    expect(isPlatformAdminActor(actor('seller'))).toBe(false);
    expect(isPlatformAdminActor(actor('customer'))).toBe(false);
    expect(isPlatformAdminActor(testCallContext(market, 'system').actor)).toBe(false);
    expect(isPlatformAdminActor(testCallContext(market, 'anonymous').actor)).toBe(false);
    expect(
      isPlatformAdminActor({ ...actor('admin'), actingAs: { sellerId: SELLER } } as never),
    ).toBe(false);
    expect(isPlatformAdminActor({ ...actor('admin'), sellerId: SELLER } as never)).toBe(false);
  });
});
