import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  REGISTER_MISMATCHES,
  REGISTER_OUTCOMES,
  blocksApproval,
  blocksSubmit,
  isFresh,
  staleReasonOf,
  registerCheckAfter,
  registerStateOf,
  sellerRegisterResultOf,
  type RegisterChecker,
} from './register-check';

// RegisterCheck (sellers design 3.4, 7.7; data design 3.4): the result of one register lookup
// for one file and one identifier value, its sticky negative, its maximum age and what each state
// allows. Pure rules, so the two Market fixtures differ only in the maximum age they configure.

const ACCOUNT = '01928a3c-0000-7000-8000-0000000000a1' as Id<'Account'>;
const SELLER: RegisterChecker = { kind: 'seller', accountId: ACCOUNT };
const REVIEWER: RegisterChecker = { kind: 'reviewer', accountId: ACCOUNT };
const JOB: RegisterChecker = { kind: 'job', accountId: null };
const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const later = (days: number, extraSeconds = 0) =>
  T0.add({ hours: days * 24, seconds: extraSeconds });

/** Per Market fixture: the configured maximum age (design 4.1; AU 30 days, ZZ a small value). */
const FIXTURES = [
  { marketId: 'AU', maxResultAgeDays: 30 },
  { marketId: 'ZZ', maxResultAgeDays: 3 },
] as const;

describe('the closed lists of data design 3.4', () => {
  it('names the outcomes and the mismatch flags', () => {
    expect(REGISTER_OUTCOMES).toEqual(['active', 'not-found', 'cancelled', 'unavailable']);
    expect(REGISTER_MISMATCHES).toEqual(['business-name', 'indirect-tax-registration', 'postcode']);
  });
});

describe('registerCheckAfter (the row written after one lookup)', () => {
  it('keeps an active answer with its mismatches and no negative mark', () => {
    const check = registerCheckAfter(null, 'active', ['postcode'], T0, SELLER);
    expect(check).toEqual({
      outcome: 'active',
      mismatches: ['postcode'],
      definiteNegativeAt: null,
      checkedAt: T0,
      checkedBy: SELLER,
    });
  });

  it('marks a definite negative at the first negative answer', () => {
    for (const outcome of ['not-found', 'cancelled'] as const) {
      const check = registerCheckAfter(null, outcome, [], T0, SELLER);
      expect(check.definiteNegativeAt).toEqual(T0);
      expect(check.mismatches).toEqual([]);
    }
  });

  it('keeps the first negative instant when the register says no again', () => {
    const first = registerCheckAfter(null, 'not-found', [], T0, SELLER);
    const again = registerCheckAfter(first, 'cancelled', [], later(1), REVIEWER);
    expect(again.outcome).toBe('cancelled');
    expect(again.definiteNegativeAt).toEqual(T0);
    expect(again.checkedAt).toEqual(later(1));
  });

  it('does not clear a definite negative on a later unavailable (AC 31)', () => {
    const negative = registerCheckAfter(null, 'not-found', [], T0, SELLER);
    const after = registerCheckAfter(negative, 'unavailable', [], later(1), SELLER);
    expect(after.outcome).toBe('unavailable');
    expect(after.definiteNegativeAt).toEqual(T0);
    expect(registerStateOf(after, later(1), 30, T0)).toBe('negative');
  });

  it('lets a later definite active answer supersede a negative (the register is the authority)', () => {
    const negative = registerCheckAfter(null, 'cancelled', [], T0, SELLER);
    const after = registerCheckAfter(negative, 'active', [], later(1), REVIEWER);
    expect(after.definiteNegativeAt).toBeNull();
    expect(registerStateOf(after, later(1), 30, T0)).toBe('active');
  });

  it('writes unavailable with no negative mark when nothing negative came before', () => {
    expect(registerCheckAfter(null, 'unavailable', [], T0, SELLER).definiteNegativeAt).toBeNull();
    const active = registerCheckAfter(null, 'active', [], T0, SELLER);
    expect(registerCheckAfter(active, 'unavailable', [], later(1), SELLER).definiteNegativeAt).toBe(
      null,
    );
  });

  it('refuses mismatches on any outcome but active (the CHECK of the table)', () => {
    for (const outcome of ['not-found', 'cancelled', 'unavailable'] as const) {
      expect(() => registerCheckAfter(null, outcome, ['postcode'], T0, SELLER)).toThrow(TypeError);
    }
  });

  it('refuses an unknown or repeated mismatch flag', () => {
    expect(() => registerCheckAfter(null, 'active', ['name' as never], T0, SELLER)).toThrow(
      TypeError,
    );
    expect(() => registerCheckAfter(null, 'active', ['postcode', 'postcode'], T0, SELLER)).toThrow(
      TypeError,
    );
  });

  it('ties the job checker to a missing account and every other checker to an account', () => {
    expect(registerCheckAfter(null, 'active', [], T0, JOB).checkedBy).toEqual(JOB);
    expect(() =>
      registerCheckAfter(null, 'active', [], T0, { kind: 'job', accountId: ACCOUNT }),
    ).toThrow(TypeError);
    expect(() =>
      registerCheckAfter(null, 'active', [], T0, { kind: 'seller', accountId: null }),
    ).toThrow(TypeError);
  });
});

describe.each(FIXTURES)(
  'registerStateOf in $marketId (maximum age $maxResultAgeDays days)',
  ({ maxResultAgeDays: max }) => {
    it('is not-performed when there is no row', () => {
      expect(registerStateOf(null, T0, max, T0)).toBe('not-performed');
    });

    it('is active while the result is within its maximum age, and stale after it', () => {
      const check = registerCheckAfter(null, 'active', [], T0, SELLER);
      expect(registerStateOf(check, T0, max, T0)).toBe('active');
      expect(registerStateOf(check, later(max), max, T0)).toBe('active');
      expect(registerStateOf(check, later(max, 1), max, T0)).toBe('stale');
    });

    it('never ages a definite negative (it stays until a successful lookup replaces it)', () => {
      const check = registerCheckAfter(null, 'not-found', [], T0, SELLER);
      expect(registerStateOf(check, later(max * 10), max, T0)).toBe('negative');
    });

    it('is unavailable for an unavailable answer', () => {
      const check = registerCheckAfter(null, 'unavailable', [], T0, SELLER);
      expect(registerStateOf(check, T0, max, T0)).toBe('unavailable');
    });

    it('is stale, not active, when the draft changed after the check (Hassan M1)', () => {
      const check = registerCheckAfter(null, 'active', [], T0, SELLER);
      const edited = T0.add({ seconds: 1 });
      expect(registerStateOf(check, T0, max, T0)).toBe('active');
      expect(registerStateOf(check, edited, max, edited)).toBe('stale');
      expect(staleReasonOf(check, edited, max, edited)).toBe('draft-changed');
      expect(staleReasonOf(check, later(max, 1), max, T0)).toBe('aged');
      expect(blocksApproval('stale', false)).toBe(true);
      expect(sellerRegisterResultOf('stale')).toBeNull();
    });

    it('does not let an edit move a negative or an unavailable result', () => {
      const edited = T0.add({ seconds: 1 });
      const negative = registerCheckAfter(null, 'not-found', [], T0, SELLER);
      const unavailable = registerCheckAfter(null, 'unavailable', [], T0, SELLER);
      expect(registerStateOf(negative, edited, max, edited)).toBe('negative');
      expect(registerStateOf(unavailable, edited, max, edited)).toBe('unavailable');
      expect(staleReasonOf(negative, edited, max, edited)).toBeNull();
    });

    it('judges freshness by the same rule', () => {
      const check = registerCheckAfter(null, 'active', [], T0, SELLER);
      expect(isFresh(check, later(max), max)).toBe(true);
      expect(isFresh(check, later(max, 1), max)).toBe(false);
    });

    it('refuses a maximum age that is not a positive whole number of days', () => {
      const check = registerCheckAfter(null, 'active', [], T0, SELLER);
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        expect(() => registerStateOf(check, T0, bad, T0)).toThrow(RangeError);
      }
    });
  },
);

describe('what each state allows (design 3.4)', () => {
  it('blocks the submission of a definite negative only', () => {
    expect(blocksSubmit('negative')).toBe(true);
    for (const state of ['not-performed', 'active', 'unavailable', 'stale'] as const) {
      expect(blocksSubmit(state)).toBe(false);
    }
  });

  it('blocks approval of a negative always, and of every unconfirmed state without a manual check (AC 32)', () => {
    expect(blocksApproval('active', false)).toBe(false);
    expect(blocksApproval('negative', false)).toBe(true);
    expect(blocksApproval('negative', true)).toBe(true);
    for (const state of ['not-performed', 'unavailable', 'stale'] as const) {
      expect(blocksApproval(state, false)).toBe(true);
      expect(blocksApproval(state, true)).toBe(false);
    }
  });
});

describe('sellerRegisterResultOf (what the seller may see; brief s5)', () => {
  it('shows matched, not matched and could-not-be-checked, and nothing otherwise', () => {
    expect(sellerRegisterResultOf('active')).toBe('matched');
    expect(sellerRegisterResultOf('negative')).toBe('not-matched');
    expect(sellerRegisterResultOf('unavailable')).toBe('could-not-be-checked');
    expect(sellerRegisterResultOf('not-performed')).toBeNull();
    expect(sellerRegisterResultOf('stale')).toBeNull();
  });
});
