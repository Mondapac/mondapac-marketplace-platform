import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  approveAtSignup,
  decideMembership,
  parseSignupSelection,
  parseCultureIds,
  parseDecision,
  requestMembership,
  type SellerCultureState,
} from './seller-culture';

const AT = Temporal.Instant.from('2026-11-12T00:00:00Z');
const LATER = Temporal.Instant.from('2026-11-12T01:00:00Z');
const seller = '01990000-0000-7000-8000-000000000001' as Id<'Seller'>;
const culture = '01990000-0000-7000-8000-0000000000c1' as Id<'Culture'>;
const account = '01990000-0000-7000-8000-0000000000a1' as Id<'Account'>;
const reviewer = '01990000-0000-7000-8000-0000000000a2' as Id<'Account'>;

const requested = (): SellerCultureState => {
  const made = requestMembership(null, {
    sellerId: seller,
    cultureId: culture,
    cultureCode: 'x',
    by: account,
    at: AT,
  });
  if (made.kind !== 'changed') throw new Error('expected a new request');
  return made.state;
};

describe('requestMembership', () => {
  it('starts a request at version 1', () => {
    expect(requested()).toMatchObject({
      status: 'requested',
      version: 1,
      reason: null,
      decidedBy: null,
    });
  });

  it('leaves a request or an approved membership as it is', () => {
    const first = requested();
    const again = {
      sellerId: seller,
      cultureId: culture,
      cultureCode: 'x',
      by: account,
      at: LATER,
    };
    expect(requestMembership(first, again)).toEqual({ kind: 'unchanged', state: first });
    const approved = decideMembership(first, {
      decision: 'approve',
      reason: null,
      by: reviewer,
      at: LATER,
    });
    expect(approved.ok && requestMembership(approved.value, again).kind).toBe('unchanged');
  });

  it('opens a rejected membership again, clears the decision and raises the version', () => {
    const rejected = decideMembership(requested(), {
      decision: 'reject',
      reason: 'No',
      by: reviewer,
      at: LATER,
    });
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    const again = requestMembership(rejected.value, {
      sellerId: seller,
      cultureId: culture,
      cultureCode: 'x',
      by: account,
      at: LATER,
    });
    expect(again).toMatchObject({
      kind: 'changed',
      state: { status: 'requested', version: 3, reason: null, decidedBy: null, decidedAt: null },
    });
  });
});

describe('decideMembership', () => {
  it('approves a request, with or without a reason', () => {
    expect(
      decideMembership(requested(), { decision: 'approve', reason: null, by: reviewer, at: LATER }),
    ).toMatchObject({
      ok: true,
      value: { status: 'approved', version: 2, decidedBy: reviewer },
    });
  });

  it('refuses a rejection without a reason, and a decision on a membership that is not requested', () => {
    expect(
      decideMembership(requested(), { decision: 'reject', reason: null, by: reviewer, at: LATER }),
    ).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'reason', code: 'required' }] },
    });
    const approved = decideMembership(requested(), {
      decision: 'approve',
      reason: null,
      by: reviewer,
      at: LATER,
    });
    if (!approved.ok) throw new Error('unexpected');
    expect(
      decideMembership(approved.value, {
        decision: 'reject',
        reason: 'No',
        by: reviewer,
        at: LATER,
      }),
    ).toEqual({
      ok: false,
      error: { code: 'culture.not-requested' },
    });
  });
});

describe('parseDecision', () => {
  it('reads a closed body: decision and an optional reason of 1 to 300 characters', () => {
    expect(parseDecision({ decision: 'reject', reason: '  Not a match  ' })).toEqual({
      ok: true,
      value: { decision: 'reject', reason: 'Not a match' },
    });
    expect(parseDecision({ decision: 'approve' })).toEqual({
      ok: true,
      value: { decision: 'approve', reason: null },
    });
    expect(parseDecision({ decision: 'maybe', extra: 1, reason: 'x'.repeat(301) })).toEqual({
      ok: false,
      error: [
        { path: 'extra', code: 'unknown-field' },
        { path: 'decision', code: 'unknown' },
        { path: 'reason', code: 'length' },
      ],
    });
    expect(parseDecision(null)).toMatchObject({ ok: false });
  });
});

describe('parseCultureIds', () => {
  const other = '01990000-0000-7000-8000-0000000000c2';
  it('takes 1 to 20 distinct ids in a closed body', () => {
    expect(parseCultureIds({ cultureIds: [culture, other] })).toEqual({
      ok: true,
      value: [culture, other],
    });
    expect(parseCultureIds({ cultureIds: [] })).toMatchObject({ ok: false });
    expect(parseCultureIds({ cultureIds: [culture, culture] })).toEqual({
      ok: false,
      error: [{ path: 'cultureIds.1', code: 'duplicate' }],
    });
    expect(parseCultureIds({ cultureIds: ['nope'] })).toEqual({
      ok: false,
      error: [{ path: 'cultureIds.0', code: 'format' }],
    });
    expect(parseCultureIds({ cultureIds: Array.from({ length: 21 }, () => culture) })).toEqual({
      ok: false,
      error: [{ path: 'cultureIds', code: 'length' }],
    });
    expect(parseCultureIds({ cultureIds: [culture], more: 1 })).toMatchObject({ ok: false });
  });
});

describe('approveAtSignup', () => {
  it('is approved at once by the system, at version 1', () => {
    expect(
      approveAtSignup({ sellerId: seller, cultureId: culture, cultureCode: 'x', by: null, at: AT }),
    ).toMatchObject({
      status: 'approved',
      version: 1,
      requestedBy: null,
      decidedBy: null,
      decidedAt: AT,
    });
  });
});

describe('parseSignupSelection', () => {
  it('reads nothing or "universal" as every Active culture', () => {
    expect(parseSignupSelection(undefined)).toEqual({ ok: true, value: { kind: 'universal' } });
    expect(parseSignupSelection('universal')).toEqual({ ok: true, value: { kind: 'universal' } });
  });

  it('reads an explicit list of codes, and refuses an empty, duplicate or malformed one', () => {
    expect(parseSignupSelection(['a', 'b-c'])).toEqual({
      ok: true,
      value: { kind: 'codes', codes: ['a', 'b-c'] },
    });
    expect(parseSignupSelection([])).toEqual({
      ok: false,
      error: [{ path: 'cultures', code: 'empty' }],
    });
    expect(parseSignupSelection(['a', 'a', 'B'])).toEqual({
      ok: false,
      error: [
        { path: 'cultures.1', code: 'duplicate' },
        { path: 'cultures.2', code: 'format' },
      ],
    });
    expect(parseSignupSelection('everything')).toEqual({
      ok: false,
      error: [{ path: 'cultures', code: 'type' }],
    });
  });
});
