import { parseId, parseMarketId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { SellerAccess, SellerAccessInvariantError, type SellerAccessState } from './seller-access';

const NOW = Temporal.Instant.from('2026-10-08T10:00:00Z');
const LATER = NOW.add({ hours: 3 });

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

const SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-0000000000a1');
const OWNER_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');

describe.each(['AU', 'ZZ'])('SellerAccess in market %s (identity design 2.1, 3.3, 8.2)', (code) => {
  const marketId = market(code);
  const selfRegistered = (approvalRequired: boolean) =>
    SellerAccess.forSelfRegistration({ sellerId: SELLER_ID, marketId, approvalRequired, now: NOW });

  describe('forSelfRegistration', () => {
    it('starts pending when the Market requires approval (SEL-03)', () => {
      const access = selfRegistered(true);

      expect(access.state).toEqual<SellerAccessState>({
        sellerId: SELLER_ID,
        marketId,
        origin: 'self',
        state: 'pending',
        stateChangedAt: NOW,
        reapplyCount: 0,
        registeredAt: null,
        version: 1,
        createdAt: NOW,
      });
      expect(access.persistedVersion).toBeNull();
      expect(access.isRegistered).toBe(false);
    });

    it('starts approved when the Market does not require approval (AC 5)', () => {
      expect(selfRegistered(false).state.state).toBe('approved');
    });

    it('records no event: a seller the purge may still delete is never published (8.2)', () => {
      expect(selfRegistered(true).pendingEvents).toEqual([]);
    });
  });

  describe('recordRegistered', () => {
    it('records seller-registered once, at the owner verification, as its version step (M4)', () => {
      const access = selfRegistered(true);

      expect(access.recordRegistered(OWNER_ID, LATER)).toBe(true);

      expect(access.state).toMatchObject({ registeredAt: LATER, version: 2, state: 'pending' });
      expect(access.isRegistered).toBe(true);
      const [event, ...rest] = access.pendingEvents;
      expect(rest).toEqual([]);
      expect(event).toMatchObject({
        type: 'identity.seller-registered.v1',
        aggregateType: 'seller-access',
        aggregateId: SELLER_ID,
        aggregateVersion: 2,
        occurredAt: LATER,
        payload: {
          sellerId: SELLER_ID,
          ownerAccountId: OWNER_ID,
          origin: 'self',
          accessState: 'pending',
        },
      });
    });

    it('carries the approved state when approval was not required', () => {
      const access = selfRegistered(false);
      access.recordRegistered(OWNER_ID, LATER);

      expect(access.pendingEvents[0]!.payload).toMatchObject({ accessState: 'approved' });
    });

    it('does nothing the second time', () => {
      const access = SellerAccess.restore({ ...selfRegistered(true).state, registeredAt: NOW });

      expect(access.recordRegistered(OWNER_ID, LATER)).toBe(false);
      expect(access.state.version).toBe(1);
      expect(access.pendingEvents).toEqual([]);
    });
  });

  describe('may sign in (3.3)', () => {
    it.each([
      ['pending', true, false],
      ['approved', true, true],
      ['rejected', true, false],
      ['suspended', false, false],
    ] as const)('state %s: sign-in %s, approved %s', (state, signIn, approved) => {
      const access = SellerAccess.restore({ ...selfRegistered(true).state, state });

      expect(access.allowsSignIn).toBe(signIn);
      expect(access.isApproved).toBe(approved);
    });
  });

  describe('restore', () => {
    it('keeps the version read as the persisted version', () => {
      const access = SellerAccess.restore({ ...selfRegistered(true).state, version: 4 });

      expect(access.persistedVersion).toBe(4);
    });

    it.each([
      ['a negative re-apply count', { reapplyCount: -1 }],
      ['a fractional re-apply count', { reapplyCount: 0.5 }],
      ['version 0', { version: 0 }],
      ['an unknown state', { state: 'frozen' }],
      ['an unknown origin', { origin: 'import' }],
    ] as const)('refuses %s', (_name, overrides) => {
      expect(() =>
        SellerAccess.restore({
          ...selfRegistered(true).state,
          ...(overrides as unknown as Partial<SellerAccessState>),
        }),
      ).toThrow(SellerAccessInvariantError);
    });
  });
});
