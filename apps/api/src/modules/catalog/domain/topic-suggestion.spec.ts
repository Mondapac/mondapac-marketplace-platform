import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { TopicSuggestion, SUGGESTION_LABEL_MAX } from './topic-suggestion';

const NOW = Temporal.Instant.from('2026-11-03T10:00:00Z');
const ADMIN = 'acct-1' as Id<'Account'>;

describe.each(['AU', 'ZZ'])('TopicSuggestion in market %s', (market) => {
  const open = (label = 'Weekend grill') => {
    const result = TopicSuggestion.open({
      id: 's1' as Id<'TopicSuggestion'>,
      marketId: market as MarketId,
      sellerId: 'sel1' as Id<'Seller'>,
      productId: 'p1' as Id<'Product'>,
      label,
      now: NOW,
    });
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  };

  it('is born open at version 1 with no notice', () => {
    expect(open().state).toMatchObject({
      status: 'open',
      version: 1,
      noticeState: 'none',
      topicId: null,
      rejectReason: null,
      marketId: market,
    });
  });

  it('keeps the normalised key of the label, so a repeat in other case is found', () => {
    expect(open('Weekend GRILL').state.labelKey).toBe(open('weekend grill').state.labelKey);
  });

  it('tidies the label and refuses an empty, over-long or control-character one', () => {
    expect(open('  Weekend   grill ').state.label).toBe('Weekend grill');
    for (const label of ['', '   ', 'x', 'x'.repeat(SUGGESTION_LABEL_MAX + 1), 'a\u0000b', 'a​b']) {
      const result = TopicSuggestion.open({
        id: 's1' as Id<'TopicSuggestion'>,
        marketId: market as MarketId,
        sellerId: 'sel1' as Id<'Seller'>,
        productId: 'p1' as Id<'Product'>,
        label,
        now: NOW,
      });
      expect(result).toEqual({ ok: false, error: { code: 'suggestion.label-invalid' } });
    }
  });

  it('is decided once: approve, map or reject move it out of open with a pending notice', () => {
    const approved = open().approve({ accountId: ADMIN, topicId: 't1' as Id<'Topic'>, now: NOW });
    if (!approved.ok) throw new Error(approved.error.code);
    expect(approved.value.state).toMatchObject({
      status: 'approved',
      topicId: 't1' as Id<'Topic'>,
      version: 2,
      noticeState: 'pending',
      noticeNextAttemptAt: NOW,
      decidedByAccountId: ADMIN,
    });
    expect(
      approved.value.map({ accountId: ADMIN, topicId: 't2' as Id<'Topic'>, now: NOW }),
    ).toEqual({
      ok: false,
      error: { code: 'suggestion.not-open' },
    });
    const mapped = open().map({ accountId: ADMIN, topicId: 't2' as Id<'Topic'>, now: NOW });
    expect(mapped.ok && mapped.value.state.status).toBe('mapped');
    const rejected = open().reject({ accountId: ADMIN, reason: ' Not a size we sell. ', now: NOW });
    expect(rejected.ok && rejected.value.state).toMatchObject({
      status: 'rejected',
      rejectReason: 'Not a size we sell.',
      topicId: null,
    });
  });

  it('refuses a missing topic and a bad reason', () => {
    expect(
      open().approve({ accountId: ADMIN, topicId: null as unknown as Id<'Topic'>, now: NOW }),
    ).toEqual({
      ok: false,
      error: { code: 'suggestion.topic-invalid' },
    });
    expect(open().reject({ accountId: ADMIN, reason: '', now: NOW })).toEqual({
      ok: false,
      error: { code: 'suggestion.reason-invalid' },
    });
    expect(open().reject({ accountId: ADMIN, reason: 'x'.repeat(301), now: NOW })).toEqual({
      ok: false,
      error: { code: 'suggestion.reason-invalid' },
    });
  });

  it('moves its notice only out of pending', () => {
    expect(open().noticeSent()).toBeNull();
    const decided = open().reject({ accountId: ADMIN, reason: 'No.', now: NOW });
    if (!decided.ok) throw new Error('decide');
    const sent = decided.value.noticeSent();
    expect(sent?.state).toMatchObject({
      noticeState: 'sent',
      noticeAttempts: 1,
      noticeNextAttemptAt: null,
    });
    expect(sent?.noticeSent()).toBeNull();
    expect(decided.value.noticeSkipped()?.state.noticeState).toBe('skipped');
  });

  it('tries a failed notice again later and gives up at the last attempt', () => {
    const decided = open().reject({ accountId: ADMIN, reason: 'No.', now: NOW });
    if (!decided.ok) throw new Error('decide');
    let current = decided.value;
    let guard = 0;
    while (current.state.noticeState === 'pending' && guard < 20) {
      const next = current.noticeFailedAt(NOW);
      if (next === null) throw new Error('settled early');
      expect(next.state.noticeAttempts).toBe(current.state.noticeAttempts + 1);
      current = next;
      guard += 1;
    }
    expect(current.state.noticeState).toBe('failed');
    expect(guard).toBeGreaterThan(1);
  });
});
