import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';
import {
  probationTarget,
  SAFE_PROBATION_OFFERS,
  SellerReviewStanding,
  trustStatusOf,
  type SellerReviewStandingState,
} from './seller-review-standing';

const T0 = Temporal.Instant.from('2026-11-25T09:00:00Z');
const at = (minutes: number) => T0.add({ minutes });
const SELLER = '01990000-0000-7000-8000-00000000c001' as Id<'Seller'>;
const OFF = { trustedFromStart: { on: false, at: null } } as const;

describe.each(TEST_MARKET_IDS)('SellerReviewStanding in market %s', (code) => {
  const marketId = code;
  const fresh = () => SellerReviewStanding.start({ marketId, sellerId: SELLER, now: T0 });
  const restored = (patch: Partial<SellerReviewStandingState>) =>
    SellerReviewStanding.restore({ ...fresh().state, version: 4, ...patch });

  describe('probationTarget', () => {
    it('is N at first and ceil(N/2) after a misconduct revocation', () => {
      expect(probationTarget('initial', 10)).toBe(10);
      expect(probationTarget('after-misconduct', 10)).toBe(5);
      expect(probationTarget('after-misconduct', 7)).toBe(4);
      expect(probationTarget('initial', 0)).toBe(0);
      expect(probationTarget('after-misconduct', 0)).toBe(0);
    });

    it('reads an N that is not a whole number from 0 to 100 as the safe 100', () => {
      for (const bad of [-1, 101, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(probationTarget('initial', bad)).toBe(SAFE_PROBATION_OFFERS);
      }
      expect(SAFE_PROBATION_OFFERS).toBe(100);
    });
  });

  describe('start', () => {
    it('opens epoch 1, initial target, no Changes needed, not Trusted, version 1', () => {
      const standing = fresh();
      expect(standing.state).toEqual({
        marketId,
        sellerId: SELLER,
        epoch: 1,
        targetKind: 'initial',
        consecutiveChangesNeeded: 0,
        trustedAt: null,
        trustLostAt: null,
        version: 1,
        createdAt: T0,
        updatedAt: T0,
      });
      expect(standing.changed).toBe(false);
    });
  });

  describe('recordApproval', () => {
    it('counts below the target without stamping, and resets a pending Changes needed', () => {
      const standing = restored({ consecutiveChangesNeeded: 1 });
      expect(standing.recordApproval({ count: 3, probationOffers: 10, now: at(1) })).toBe(
        'counted',
      );
      expect(standing.state.consecutiveChangesNeeded).toBe(0);
      expect(standing.state.trustedAt).toBeNull();
      expect(standing.state.updatedAt).toEqual(at(1));
      expect(standing.changed).toBe(true);
    });

    it('is a no-op below the target with nothing to reset (no write)', () => {
      const standing = restored({});
      expect(standing.recordApproval({ count: 2, probationOffers: 10, now: at(1) })).toBe(
        'counted',
      );
      expect(standing.changed).toBe(false);
    });

    it('stamps trustedAt when the count reaches the target', () => {
      const standing = restored({ consecutiveChangesNeeded: 1 });
      expect(standing.recordApproval({ count: 10, probationOffers: 10, now: at(2) })).toBe(
        'trusted',
      );
      expect(standing.state.trustedAt).toEqual(at(2));
      expect(standing.state.consecutiveChangesNeeded).toBe(0);
    });

    it('uses the after-misconduct target of ceil(N/2)', () => {
      const standing = restored({ epoch: 2, targetKind: 'after-misconduct', trustLostAt: at(0) });
      expect(standing.recordApproval({ count: 5, probationOffers: 10, now: at(3) })).toBe(
        'trusted',
      );
    });

    it('does nothing once Trusted', () => {
      const standing = restored({ trustedAt: at(1) });
      expect(standing.recordApproval({ count: 30, probationOffers: 10, now: at(5) })).toBe(
        'ignored',
      );
      expect(standing.state.trustedAt).toEqual(at(1));
      expect(standing.changed).toBe(false);
    });

    it('refuses a negative or fractional count', () => {
      expect(() =>
        fresh().recordApproval({ count: -1, probationOffers: 10, now: at(1) }),
      ).toThrow();
      expect(() =>
        fresh().recordApproval({ count: 1.5, probationOffers: 10, now: at(1) }),
      ).toThrow();
    });
  });

  describe('recordChangesNeeded', () => {
    it('remembers the first Changes needed in a row', () => {
      const standing = restored({});
      expect(standing.recordChangesNeeded({ now: at(1) })).toBe('counted');
      expect(standing.state.consecutiveChangesNeeded).toBe(1);
      expect(standing.state.epoch).toBe(1);
      expect(standing.changed).toBe(true);
    });

    it('restarts the epoch on the second in a row (count back to 0)', () => {
      const standing = restored({ consecutiveChangesNeeded: 1 });
      expect(standing.recordChangesNeeded({ now: at(2) })).toBe('restarted');
      expect(standing.state).toMatchObject({
        epoch: 2,
        consecutiveChangesNeeded: 0,
        targetKind: 'initial',
        trustedAt: null,
        updatedAt: at(2),
      });
    });

    it('keeps the after-misconduct target across a restart', () => {
      const standing = restored({
        epoch: 3,
        targetKind: 'after-misconduct',
        trustLostAt: at(0),
        consecutiveChangesNeeded: 1,
      });
      standing.recordChangesNeeded({ now: at(1) });
      expect(standing.state).toMatchObject({ epoch: 4, targetKind: 'after-misconduct' });
    });

    it('does nothing once Trusted', () => {
      const standing = restored({ trustedAt: at(1) });
      expect(standing.recordChangesNeeded({ now: at(2) })).toBe('ignored');
      expect(standing.changed).toBe(false);
    });

    it('an approval between two Changes needed breaks the row', () => {
      const standing = restored({});
      standing.recordChangesNeeded({ now: at(1) });
      standing.recordApproval({ count: 1, probationOffers: 10, now: at(2) });
      expect(standing.recordChangesNeeded({ now: at(3) })).toBe('counted');
      expect(standing.state.epoch).toBe(1);
    });
  });

  describe('revokeForMisconduct', () => {
    it('clears Trusted, opens an after-misconduct epoch and stamps trustLostAt', () => {
      const standing = restored({ trustedAt: at(1) });
      expect(standing.revokeForMisconduct({ now: at(9) })).toBe('revoked');
      expect(standing.state).toMatchObject({
        epoch: 2,
        targetKind: 'after-misconduct',
        trustedAt: null,
        trustLostAt: at(9),
        consecutiveChangesNeeded: 0,
        updatedAt: at(9),
      });
      expect(standing.changed).toBe(true);
    });

    it('also applies in probation, and a later revocation moves trustLostAt forward', () => {
      const standing = restored({ consecutiveChangesNeeded: 1 });
      standing.revokeForMisconduct({ now: at(3) });
      standing.revokeForMisconduct({ now: at(4) });
      expect(standing.state).toMatchObject({ epoch: 3, trustLostAt: at(4) });
    });

    it('refuses a revocation at or before the last one', () => {
      const standing = restored({ epoch: 2, targetKind: 'after-misconduct', trustLostAt: at(5) });
      expect(() => standing.revokeForMisconduct({ now: at(5) })).toThrow();
    });
  });

  describe('stampTrust', () => {
    it('stamps a seller whose count already meets a lowered N', () => {
      const standing = restored({});
      expect(standing.stampTrust({ count: 4, probationOffers: 3, now: at(1) })).toBe(true);
      expect(standing.state.trustedAt).toEqual(at(1));
    });

    it('does nothing below the target or once Trusted', () => {
      expect(restored({}).stampTrust({ count: 2, probationOffers: 3, now: at(1) })).toBe(false);
      const trusted = restored({ trustedAt: at(0) });
      expect(trusted.stampTrust({ count: 9, probationOffers: 3, now: at(1) })).toBe(false);
      expect(trusted.changed).toBe(false);
    });

    it('never stamps while N is 0, for either target kind (Hadi (a) on Hassan S2)', () => {
      for (const targetKind of ['initial', 'after-misconduct'] as const) {
        const standing = restored({
          targetKind,
          epoch: 2,
          trustLostAt: targetKind === 'initial' ? null : T0,
        });
        expect(standing.stampTrust({ count: 0, probationOffers: 0, now: at(1) })).toBe(false);
        expect(standing.stampTrust({ count: 5, probationOffers: 0, now: at(1) })).toBe(false);
        expect(standing.recordApproval({ count: 1, probationOffers: 0, now: at(1) })).toBe(
          'counted',
        );
        expect(standing.state.trustedAt).toBeNull();
      }
    });

    it('with N 0 then raised to 3, a seller below 3 is in probation again', () => {
      const standing = fresh();
      standing.recordApproval({ count: 1, probationOffers: 0, now: at(1) });
      const facts = { ...standing.state, count: 1 };
      expect(trustStatusOf(facts, OFF, 0)).toMatchObject({ status: 'trusted', trustedSince: null });
      expect(trustStatusOf(facts, OFF, 3)).toMatchObject({ status: 'probation', target: 3 });
    });
  });
});

describe('trustStatusOf (pure)', () => {
  const view = (patch: Partial<Parameters<typeof trustStatusOf>[0] & object> = {}) => ({
    targetKind: 'initial' as const,
    trustedAt: null,
    trustLostAt: null,
    count: 0,
    ...patch,
  });

  it('is probation for a seller with no standing yet', () => {
    expect(trustStatusOf(null, OFF, 10)).toEqual({
      status: 'probation',
      source: null,
      trustedSince: null,
      count: 0,
      target: 10,
    });
  });

  it('is Trusted (count) from trustedAt, whatever N is now (raising N never demotes)', () => {
    expect(trustStatusOf(view({ trustedAt: at(1), count: 10 }), OFF, 50)).toEqual({
      status: 'trusted',
      source: 'count',
      trustedSince: at(1),
      count: 10,
      target: 50,
    });
  });

  it('is Trusted (count) at once when N is lowered under the count, not yet stamped', () => {
    expect(trustStatusOf(view({ count: 6 }), OFF, 5)).toEqual({
      status: 'trusted',
      source: 'count',
      trustedSince: null,
      count: 6,
      target: 5,
    });
  });

  it('is never probation when N is 0', () => {
    expect(trustStatusOf(null, OFF, 0).status).toBe('trusted');
  });

  it('counts the after-misconduct target', () => {
    const lost = view({ targetKind: 'after-misconduct', trustLostAt: at(0), count: 5 });
    expect(trustStatusOf(lost, OFF, 10)).toMatchObject({ status: 'trusted', target: 5 });
    expect(trustStatusOf({ ...lost, count: 4 }, OFF, 10)).toMatchObject({ status: 'probation' });
  });

  it('is Trusted (admin) from the Trusted-from-start flag, trustedSince its change time', () => {
    const flags = { trustedFromStart: { on: true, at: at(2) } };
    expect(trustStatusOf(null, flags, 10)).toEqual({
      status: 'trusted',
      source: 'admin',
      trustedSince: at(2),
      count: 0,
      target: 10,
    });
  });

  it('ignores a flag switched on before the last misconduct revocation', () => {
    const lost = view({ targetKind: 'after-misconduct', trustLostAt: at(5), count: 1 });
    expect(trustStatusOf(lost, { trustedFromStart: { on: true, at: at(4) } }, 10).status).toBe(
      'probation',
    );
    expect(trustStatusOf(lost, { trustedFromStart: { on: true, at: at(5) } }, 10).status).toBe(
      'probation',
    );
    expect(trustStatusOf(lost, { trustedFromStart: { on: true, at: at(6) } }, 10)).toMatchObject({
      status: 'trusted',
      source: 'admin',
      trustedSince: at(6),
    });
  });

  it('reads a flag that is on with no change time as off (fail closed)', () => {
    expect(trustStatusOf(null, { trustedFromStart: { on: true, at: null } }, 10).status).toBe(
      'probation',
    );
  });

  it('returns to probation with the current count when the flag goes off', () => {
    expect(trustStatusOf(view({ count: 3 }), OFF, 10)).toMatchObject({
      status: 'probation',
      count: 3,
    });
  });
});
