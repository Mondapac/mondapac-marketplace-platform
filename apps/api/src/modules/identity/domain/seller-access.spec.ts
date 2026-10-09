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
const ADMIN_ID = id<'Account'>('01990000-0000-7000-8000-000000000009');
const DECISION_ID = id<'AccessDecision'>('01990000-0000-7000-8000-0000000000d1');
const BASIS_ID = id('01990000-0000-7000-8000-0000000000b1');

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

  describe('forInvitation (3.4 seller-owner; SEL-06, AC 31)', () => {
    const invited = (approvalRequired: boolean) =>
      SellerAccess.forInvitation({ sellerId: SELLER_ID, marketId, approvalRequired, now: NOW });

    it('starts pending when the Market requires approval, registered at once (8.2)', () => {
      const access = invited(true);

      expect(access.state).toEqual<SellerAccessState>({
        sellerId: SELLER_ID,
        marketId,
        origin: 'invitation',
        state: 'pending',
        stateChangedAt: NOW,
        reapplyCount: 0,
        registeredAt: NOW,
        version: 1,
        createdAt: NOW,
      });
      expect(access.isRegistered).toBe(true);
    });

    it('starts approved when the Market does not require approval (AC 5)', () => {
      expect(invited(false).state.state).toBe('approved');
    });

    it('records seller-registered at creation, without an owner yet (8.2)', () => {
      const [event, ...rest] = invited(true).pendingEvents;

      expect(rest).toEqual([]);
      expect(event).toMatchObject({
        type: 'identity.seller-registered.v1',
        aggregateId: SELLER_ID,
        aggregateVersion: 1,
        occurredAt: NOW,
        payload: {
          sellerId: SELLER_ID,
          ownerAccountId: null,
          origin: 'invitation',
          accessState: 'pending',
        },
      });
    });
  });

  describe('decisions (3.3; SEL-03, SEL-07, decision 9)', () => {
    const inState = (state: SellerAccessState['state'], reapplyCount = 0) =>
      SellerAccess.restore({
        ...selfRegistered(true).state,
        registeredAt: NOW,
        state,
        reapplyCount,
        version: 3,
      });
    const by = { decisionId: DECISION_ID, decidedBy: ADMIN_ID, now: LATER };

    it('approves a pending seller: a decision, the state, a version step, the event', () => {
      const access = inState('pending', 2);

      const decided = access.approve({ ...by, basisId: BASIS_ID });

      expect(decided.ok && decided.value.state).toEqual({
        id: DECISION_ID,
        marketId,
        sellerId: SELLER_ID,
        decision: 'approved',
        reason: null,
        basisId: BASIS_ID,
        decidedByAccountId: ADMIN_ID,
        decidedAt: LATER,
      });
      // "Fewer than 3 re-applications since the last approval": the count starts again.
      expect(access.state).toMatchObject({
        state: 'approved',
        stateChangedAt: LATER,
        reapplyCount: 0,
        version: 4,
      });
      expect(access.pendingEvents).toEqual([
        expect.objectContaining({
          type: 'identity.seller-access-approved.v1',
          aggregateType: 'seller-access',
          aggregateId: SELLER_ID,
          aggregateVersion: 4,
          occurredAt: LATER,
          payload: { sellerId: SELLER_ID, decisionId: DECISION_ID, basisId: BASIS_ID },
        }),
      ]);
    });

    it('rejects a pending seller with its reason; the event never carries it', () => {
      const access = inState('pending');

      const decided = access.reject({ ...by, basisId: null, reason: ' Missing ABN. ' });

      expect(decided.ok && decided.value.state).toMatchObject({
        decision: 'rejected',
        reason: 'Missing ABN.',
        basisId: null,
      });
      expect(access.state).toMatchObject({ state: 'rejected', version: 4 });
      expect(access.pendingEvents[0]).toMatchObject({
        type: 'identity.seller-access-rejected.v1',
        payload: { sellerId: SELLER_ID, decisionId: DECISION_ID, basisId: null },
      });
      expect(JSON.stringify(access.pendingEvents)).not.toContain('Missing ABN');
    });

    it('suspends an approved seller with its reason, and reinstates it', () => {
      const access = inState('approved');

      const suspended = access.suspend({ ...by, reason: 'Complaints under review.' });
      expect(suspended.ok && suspended.value.state).toMatchObject({
        decision: 'suspended',
        reason: 'Complaints under review.',
      });
      expect(access.state).toMatchObject({ state: 'suspended', version: 4 });
      expect(access.allowsSignIn).toBe(false);

      const reinstateId = id<'AccessDecision'>('01990000-0000-7000-8000-0000000000d2');
      const later = LATER.add({ hours: 1 });
      const reinstated = access.reinstate({
        decisionId: reinstateId,
        decidedBy: ADMIN_ID,
        now: later,
      });
      expect(reinstated.ok && reinstated.value.state).toMatchObject({
        id: reinstateId,
        decision: 'reinstated',
        reason: null,
      });
      expect(access.state).toMatchObject({ state: 'approved', stateChangedAt: later, version: 5 });
      expect(access.pendingEvents.map((event) => [event.type, event.aggregateVersion])).toEqual([
        ['identity.seller-access-suspended.v1', 4],
        ['identity.seller-access-reinstated.v1', 5],
      ]);
    });

    it.each(['', ' \n '])(
      'refuses to reject without a reason (%j) and changes nothing (AC 6)',
      (reason) => {
        const access = inState('pending');

        expect(access.reject({ ...by, basisId: null, reason })).toEqual({
          ok: false,
          error: { code: 'seller-access.reason-required' },
        });
        expect(access.state).toMatchObject({ state: 'pending', version: 3 });
        expect(access.pendingEvents).toEqual([]);
      },
    );

    it('refuses to suspend without a reason and changes nothing (AC 14)', () => {
      const access = inState('approved');

      expect(access.suspend({ ...by, reason: '' })).toEqual({
        ok: false,
        error: { code: 'seller-access.reason-required' },
      });
      expect(access.state).toMatchObject({ state: 'approved', version: 3 });
    });

    it('refuses a malformed reason with its rule', () => {
      const access = inState('approved');

      expect(access.suspend({ ...by, reason: 'bad\u202e' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', rule: 'characters' },
      });
    });

    // Every transition 3.3 does not list, and the most tempting ones by name.
    it.each([
      ['approve', 'approved'],
      ['approve', 'rejected'],
      ['approve', 'suspended'],
      ['reject', 'approved'],
      ['reject', 'rejected'],
      ['reject', 'suspended'],
      ['suspend', 'pending'],
      ['suspend', 'rejected'],
      ['suspend', 'suspended'],
      ['reinstate', 'pending'],
      ['reinstate', 'approved'],
      ['reinstate', 'rejected'],
    ] as const)('refuses to %s a seller that is %s (seller-access.wrong-state)', (verb, from) => {
      const access = inState(from);
      const decide = {
        approve: () => access.approve({ ...by, basisId: null }),
        reject: () => access.reject({ ...by, basisId: null, reason: 'Why.' }),
        suspend: () => access.suspend({ ...by, reason: 'Why.' }),
        reinstate: () => access.reinstate(by),
      }[verb];

      expect(decide()).toEqual({ ok: false, error: { code: 'seller-access.wrong-state' } });
      expect(access.state).toMatchObject({ state: from, version: 3 });
      expect(access.pendingEvents).toEqual([]);
    });

    it('checks the state before the reason', () => {
      expect(inState('suspended').reject({ ...by, basisId: null, reason: '' })).toEqual({
        ok: false,
        error: { code: 'seller-access.wrong-state' },
      });
    });

    // Slice 9b: the admin seller list's hints ask the same rule as the transitions.
    const STATES = ['pending', 'approved', 'rejected', 'suspended'] as const;
    const VERBS = ['approve', 'reject', 'suspend', 'reinstate'] as const;
    it.each(STATES.flatMap((state) => VERBS.map((verb) => [verb, state] as const)))(
      'decisionAllowedFrom(%s, %s) says what the transition answers',
      (verb, state) => {
        const access = inState(state);
        const outcome = {
          approve: () => access.approve({ ...by, basisId: null }),
          reject: () => access.reject({ ...by, basisId: null, reason: 'Why.' }),
          suspend: () => access.suspend({ ...by, reason: 'Why.' }),
          reinstate: () => access.reinstate(by),
        }[verb]();

        expect(SellerAccess.decisionAllowedFrom(state, verb)).toBe(outcome.ok);
      },
    );
  });

  describe('reapplyLimitReached (3.3; the status read and the admin seller list)', () => {
    it.each([
      ['rejected', 3, 3, true],
      ['rejected', 4, 3, true],
      ['rejected', 2, 3, false],
      ['pending', 3, 3, false],
      ['approved', 0, 1, false],
      ['suspended', 5, 3, false],
    ] as const)(
      '%s with %s re-applications under a limit of %s: %s',
      (state, count, limit, reached) => {
        const access = SellerAccess.restore({
          ...selfRegistered(true).state,
          registeredAt: NOW,
          state,
          reapplyCount: count,
          version: 3,
        });

        expect(SellerAccess.reapplyLimitReached(state, count, limit)).toBe(reached);
        expect(SellerAccess.reapplyLimitReached(state, count, limit)).toBe(
          state === 'rejected' && !access.canReapply(limit),
        );
      },
    );

    it('refuses a limit that is not a positive whole number', () => {
      expect(() => SellerAccess.reapplyLimitReached('rejected', 0, 0)).toThrow(RangeError);
    });
  });

  describe('reapply (3.3: rejected → pending, behind the facade)', () => {
    const rejected = (reapplyCount: number) =>
      SellerAccess.restore({
        ...selfRegistered(true).state,
        registeredAt: NOW,
        state: 'rejected',
        reapplyCount,
        version: 3,
      });

    it.each([0, 1, 2])('moves a rejected seller with %s re-applications to pending', (count) => {
      const access = rejected(count);

      expect(access.reapply(LATER, 3)).toEqual({ ok: true, value: undefined });

      expect(access.state).toMatchObject({
        state: 'pending',
        stateChangedAt: LATER,
        reapplyCount: count + 1,
        version: 4,
      });
      expect(access.pendingEvents).toEqual([
        expect.objectContaining({
          type: 'identity.seller-access-reapplied.v1',
          aggregateVersion: 4,
          payload: { sellerId: SELLER_ID },
        }),
      ]);
    });

    it('answers seller-access.reapply-limit at the limit, and the seller stays rejected', () => {
      const access = rejected(3);

      expect(access.reapply(LATER, 3)).toEqual({
        ok: false,
        error: { code: 'seller-access.reapply-limit' },
      });
      expect(access.state).toMatchObject({ state: 'rejected', reapplyCount: 3, version: 3 });
      expect(access.canReapply(3)).toBe(false);
      expect(rejected(2).canReapply(3)).toBe(true);
    });

    it.each(['pending', 'approved', 'suspended'] as const)(
      'refuses a seller that is %s',
      (state) => {
        const access = SellerAccess.restore({ ...rejected(0).state, state });

        expect(access.reapply(LATER, 3)).toEqual({
          ok: false,
          error: { code: 'seller-access.wrong-state' },
        });
        expect(access.canReapply(3)).toBe(false);
      },
    );

    it('refuses a limit that is not a positive whole number', () => {
      expect(() => rejected(0).reapply(LATER, 0)).toThrow(RangeError);
      expect(() => rejected(0).reapply(LATER, 1.5)).toThrow(RangeError);
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
