import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import type { RegisterSnapshot } from './business-file-revision';
import { registerCheckAfter, type RegisterCheck } from './register-check';
import { MANUAL_CHECK_MAX_AGE_DAYS, registerGuard, type ManualRegisterCheck } from './review-check';

// The register guard of an approval (sellers design 3.4; AC 31, 32; slice 7a-decide).

const SUBMITTED = Temporal.Instant.from('2026-10-10T10:00:00Z');
const NOW = SUBMITTED.add({ hours: 1 });
const REVIEWER = { kind: 'reviewer', accountId: 'a' as Id<'Account'> } as const;
const NONE: RegisterSnapshot = { outcome: 'not-performed', mismatches: [], checkedAt: null };

const check = (
  outcome: 'active' | 'not-found' | 'unavailable',
  at: Temporal.Instant,
): RegisterCheck => registerCheckAfter(null, outcome, [], at, REVIEWER, 1);
const manual = (
  observed: ManualRegisterCheck['observed'],
  recordedAt = NOW,
): ManualRegisterCheck => ({
  revisionId: 'r' as Id<'BusinessFileRevision'>,
  observed,
  recordedByAccountId: 'a' as Id<'Account'>,
  recordedAt,
});
// The two Market fixtures differ in their maximum result age (AU 30 days, ZZ 3).
describe.each([
  ['AU', 30],
  ['ZZ', 3],
] as const)('registerGuard in %s', (_code, maxAge) => {
  const guard = (input: Partial<Parameters<typeof registerGuard>[0]>) =>
    registerGuard({
      hasIdentifier: true,
      lookupMaxResultAgeDays: maxAge,
      snapshot: NONE,
      submittedAt: SUBMITTED,
      check: null,
      manual: null,
      now: NOW,
      ...input,
    });

  it('passes a revision without an identifier', () => {
    expect(guard({ hasIdentifier: false }).ok).toBe(true);
  });

  it('passes a fresh active result obtained after the submission, or the one the submission saw', () => {
    expect(guard({ check: check('active', SUBMITTED.add({ minutes: 5 })) }).ok).toBe(true);
    const before = SUBMITTED.subtract({ minutes: 5 });
    expect(
      guard({
        check: check('active', before),
        snapshot: { outcome: 'active', mismatches: [], checkedAt: before },
      }).ok,
    ).toBe(true);
  });

  it('asks for a manual check otherwise: no lookup, an older result, unavailable, aged', () => {
    const required = { ok: false, error: { code: 'review.manual-register-check-required' } };
    expect(guard({ lookupMaxResultAgeDays: null })).toEqual(required);
    expect(guard({ check: check('active', SUBMITTED.subtract({ minutes: 5 })) })).toEqual(required);
    expect(guard({ check: check('unavailable', NOW) })).toEqual(required);
    expect(
      guard({
        check: check('active', SUBMITTED.add({ minutes: 5 })),
        now: NOW.add({ hours: 24 * 31 }),
      }),
    ).toEqual(required);
    expect(guard({ lookupMaxResultAgeDays: null, manual: manual('active') }).ok).toBe(true);
  });

  it('refuses a negative, stored or read by hand, and a stored negative beats a manual active (AC 31)', () => {
    const negative = { ok: false, error: { code: 'review.register-negative' } };
    expect(guard({ manual: manual('cancelled') })).toEqual(negative);
    expect(guard({ check: check('not-found', NOW), manual: manual('active') })).toEqual(negative);
  });

  it('lets a manual active reading age out like a lookup result', () => {
    const required = { ok: false, error: { code: 'review.manual-register-check-required' } };
    const old = NOW.subtract({ hours: 24 * maxAge + 1 });
    expect(guard({ manual: manual('active', old) })).toEqual(required);
    const withoutLookup = NOW.subtract({ hours: 24 * MANUAL_CHECK_MAX_AGE_DAYS + 1 });
    expect(
      guard({ lookupMaxResultAgeDays: null, manual: manual('active', withoutLookup) }),
    ).toEqual(required);
  });
});
