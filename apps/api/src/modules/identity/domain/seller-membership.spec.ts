import { parseId, parseMarketId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import {
  SellerMembership,
  SellerMembershipInvariantError,
  type SellerMembershipState,
} from './seller-membership';

const NOW = Temporal.Instant.from('2026-10-08T10:00:00Z');

function id<K extends string>(text: string): Id<K> {
  const parsed = parseId<K>(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
}
function market(code: string): MarketId {
  const parsed = parseMarketId(code);
  if (!parsed.ok) throw new Error('bad market');
  return parsed.value;
}

const MEMBERSHIP_ID = id<'SellerMembership'>('01990000-0000-7000-8000-0000000000c1');
const ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');
const SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-0000000000a1');

describe.each(['AU', 'ZZ'])('SellerMembership in market %s (identity design 2.1, 2.3)', (code) => {
  const marketId = market(code);
  const founding = () =>
    SellerMembership.found({
      id: MEMBERSHIP_ID,
      marketId,
      accountId: ACCOUNT_ID,
      sellerId: SELLER_ID,
      now: NOW,
    });

  it('founds an active membership of the account in the seller, version 1, no event', () => {
    const membership = founding();

    expect(membership.state).toEqual<SellerMembershipState>({
      id: MEMBERSHIP_ID,
      marketId,
      accountId: ACCOUNT_ID,
      sellerId: SELLER_ID,
      state: 'active',
      removedAt: null,
      version: 1,
      createdAt: NOW,
    });
    expect(membership.isActive).toBe(true);
    expect(membership.persistedVersion).toBeNull();
    expect(membership.pendingEvents).toEqual([]);
  });

  it('restores a removed membership, which is not active', () => {
    const removed = SellerMembership.restore({
      ...founding().state,
      state: 'removed',
      removedAt: NOW,
      version: 2,
    });

    expect(removed.isActive).toBe(false);
    expect(removed.persistedVersion).toBe(2);
  });

  it.each([
    ['an unknown state', { state: 'paused' }],
    ['a removed membership without its instant', { state: 'removed', removedAt: null }],
    ['an active membership with a removal instant', { removedAt: NOW }],
    ['version 0', { version: 0 }],
  ] as const)('refuses %s', (_name, overrides) => {
    expect(() =>
      SellerMembership.restore({
        ...founding().state,
        ...(overrides as unknown as Partial<SellerMembershipState>),
      }),
    ).toThrow(SellerMembershipInvariantError);
  });
});
