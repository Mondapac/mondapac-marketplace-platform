import { Temporal } from '@mondapac/shared-kernel';
import {
  approvalNeeded,
  isAdminCreditReason,
  isPastExpiry,
  isRejectReason,
  localDayOf,
  MAX_NOTE_LENGTH,
  normalisedNote,
  requestExpiry,
} from './admin-credit';

// The rules of admin credit issuance (package 2a), on both Market fixtures' numbers: AU (AUD,
// 50.00 per issue, 500.00 per day, Australia/Brisbane) and ZZ (JPY, 3000 per issue, 30000 per day,
// Asia/Tokyo).

describe.each([
  ['AU', 5000n, 50000n, 'Australia/Brisbane'],
  ['ZZ', 3000n, 30000n, 'Asia/Tokyo'],
] as const)('admin credit caps in market %s', (_code, issueCap, dailyCap, timeZone) => {
  const decide = (amount: bigint, usedToday = 0n) =>
    approvalNeeded({ amount, usedToday, issueCap, dailyCap });

  it('grants at once up to and including the per-issue cap', () => {
    expect(decide(1n)).toBeNull();
    expect(decide(issueCap)).toBeNull();
    expect(decide(issueCap + 1n)).toBe('issue-cap');
  });

  it('grants at once while the day stays within the daily cap, exactly at it included', () => {
    expect(decide(issueCap, dailyCap - issueCap)).toBeNull();
    expect(decide(1n, dailyCap - 1n)).toBeNull();
    expect(decide(1n, dailyCap)).toBe('daily-cap');
    expect(decide(issueCap, dailyCap - issueCap + 1n)).toBe('daily-cap');
  });

  it('names the per-issue cap first when both are passed', () => {
    expect(decide(issueCap + 1n, dailyCap)).toBe('issue-cap');
  });

  it("counts the day in the Market's time zone, not UTC", () => {
    // 15:30 UTC is already the next day in Brisbane (+10) and Tokyo (+9).
    const lateUtc = Temporal.Instant.from('2026-10-25T15:30:00Z');
    expect(localDayOf(lateUtc, timeZone)).toBe('2026-10-26');
    expect(localDayOf(Temporal.Instant.from('2026-10-25T13:59:59Z'), timeZone)).toBe('2026-10-25');
  });

  it("expires a pending request after whole calendar days in the Market's zone", () => {
    const now = Temporal.Instant.from('2026-10-25T10:00:00Z');
    const at = requestExpiry(now, 7, timeZone);
    expect(at.toString()).toBe('2026-11-01T10:00:00Z');
    expect(isPastExpiry(at, at.subtract({ milliseconds: 1 }))).toBe(false);
    expect(isPastExpiry(at, at)).toBe(true);
    expect(isPastExpiry(null, at)).toBe(false);
  });
});

describe('admin credit reasons and notes', () => {
  it('accepts only the closed reason lists', () => {
    expect(isAdminCreditReason('goodwill')).toBe(true);
    expect(isAdminCreditReason('welcome')).toBe(false);
    expect(isAdminCreditReason(undefined)).toBe(false);
    expect(isRejectReason('duplicate')).toBe(true);
    expect(isRejectReason('goodwill')).toBe(false);
  });

  it('stores a trimmed note of at most 500 characters; blank is no note', () => {
    expect(normalisedNote(undefined)).toEqual({ ok: true, note: null });
    expect(normalisedNote('   ')).toEqual({ ok: true, note: null });
    expect(normalisedNote('  late parcel\r\nsorry ')).toEqual({
      ok: true,
      note: 'late parcel\nsorry',
    });
    expect(normalisedNote('ب'.repeat(MAX_NOTE_LENGTH))).toMatchObject({ ok: true });
    expect(normalisedNote('x'.repeat(MAX_NOTE_LENGTH + 1))).toEqual({ ok: false, code: 'length' });
    expect(normalisedNote(12)).toEqual({ ok: false, code: 'type' });
    expect(normalisedNote('bell\u0007')).toEqual({ ok: false, code: 'format' });
    expect(normalisedNote('rtl‮override')).toEqual({ ok: false, code: 'format' });
  });
});
