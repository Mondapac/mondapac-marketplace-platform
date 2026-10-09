import { parseId, parseMarketId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import {
  AccessDecision,
  AccessDecisionInvariantError,
  MAX_ACCESS_REASON_LENGTH,
  parseAccessReason,
  type AccessDecisionState,
} from './access-decision';

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

const SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-0000000000a1');
const DECISION_ID = id<'AccessDecision'>('01990000-0000-7000-8000-0000000000d1');
const ADMIN_ID = id<'Account'>('01990000-0000-7000-8000-000000000009');

describe('parseAccessReason (identity design 3.3, decision 9; HF13)', () => {
  it('trims the reason and keeps line breaks, as the seller reads it', () => {
    expect(parseAccessReason('  Your ABN does not match.\r\nPlease upload it again.  ')).toEqual({
      ok: true,
      value: 'Your ABN does not match.\nPlease upload it again.',
    });
  });

  it.each([
    ['an empty string', ''],
    ['only spaces and line breaks', ' \n\t  \r\n '],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
  ])('answers seller-access.reason-required for %s (AC 6, AC 14)', (_name, raw) => {
    expect(parseAccessReason(raw)).toEqual({
      ok: false,
      error: { code: 'seller-access.reason-required' },
    });
  });

  it(`takes up to ${MAX_ACCESS_REASON_LENGTH} characters and refuses one more`, () => {
    const longest = 'é'.repeat(MAX_ACCESS_REASON_LENGTH);
    expect(parseAccessReason(longest)).toEqual({ ok: true, value: longest });
    expect(parseAccessReason(`${longest}x`)).toEqual({
      ok: false,
      error: { code: 'validation.failed', rule: 'length' },
    });
  });

  it.each([
    ['a C0 control', 'Wrong\u0007 file'],
    ['a C1 control', 'Wrong\u0085 file'],
    ['a bidi override', 'Wrong \u202efile'],
    ['a bidi isolate', 'Wrong \u2066file'],
    ['a lone surrogate', 'Wrong \ud800 file'],
  ])('refuses %s (HF13: the text reaches a mail and a page)', (_name, raw) => {
    expect(parseAccessReason(raw)).toEqual({
      ok: false,
      error: { code: 'validation.failed', rule: 'characters' },
    });
  });

  it('keeps tabs, emoji and every script', () => {
    expect(parseAccessReason('السبب:\tالوثيقة 📄 ناقصة')).toEqual({
      ok: true,
      value: 'السبب:\tالوثيقة 📄 ناقصة',
    });
  });
});

describe.each(['AU', 'ZZ'])('AccessDecision in market %s (data design 3.11)', (code) => {
  const marketId = market(code);
  const state = (overrides: Partial<AccessDecisionState>): AccessDecisionState => ({
    id: DECISION_ID,
    marketId,
    sellerId: SELLER_ID,
    decision: 'rejected',
    reason: 'Missing document.',
    basisId: null,
    decidedByAccountId: ADMIN_ID,
    decidedAt: NOW,
    ...overrides,
  });

  it.each(['rejected', 'suspended'] as const)('a %s decision carries its reason', (decision) => {
    expect(AccessDecision.restore(state({ decision })).state.reason).toBe('Missing document.');
  });

  it.each(['approved', 'reinstated'] as const)('a %s decision has none', (decision) => {
    expect(AccessDecision.restore(state({ decision, reason: null })).state.reason).toBeNull();
  });

  it.each([
    ['a rejection without a reason', { decision: 'rejected', reason: null }],
    ['a suspension with an empty reason', { decision: 'suspended', reason: '   ' }],
    ['an approval with a reason', { decision: 'approved', reason: 'x' }],
    ['a reinstatement with a reason', { decision: 'reinstated', reason: 'x' }],
    ['an unknown decision', { decision: 'frozen', reason: null }],
    ['a reason that is not as parsed', { reason: ' padded ' }],
  ] as const)('refuses %s', (_name, overrides) => {
    expect(() =>
      AccessDecision.restore(state(overrides as unknown as Partial<AccessDecisionState>)),
    ).toThrow(AccessDecisionInvariantError);
  });
});
