import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { FixedClock, SequenceIdGenerator } from '@mondapac/shared-kernel/testing';
import { OfferPendingChange, MAX_DECISION_NOTE_CHARS } from './offer-pending-change';

const T0 = Temporal.Instant.from('2026-11-25T00:00:00Z');
const T1 = Temporal.Instant.from('2026-11-25T01:00:00Z');

describe.each(['AU', 'ZZ'] as const)('OfferPendingChange in market %s', (marketId) => {
  const ids = new SequenceIdGenerator(new FixedClock(T0));
  const admin = ids.next<'Account'>();
  const seller = ids.next<'Account'>();

  const propose = (
    overrides: Partial<Parameters<typeof OfferPendingChange.propose>[0]> = {},
  ): OfferPendingChange => {
    const made = OfferPendingChange.propose({
      id: ids.next<'OfferPendingChange'>(),
      marketId: marketId as MarketId,
      offerId: ids.next<'Offer'>(),
      sellerId: ids.next<'Seller'>(),
      baseOfferVersion: 4,
      proposedHandling: 'REPACKED',
      reasons: ['handling'],
      policyVersion: 2,
      submittedByAccountId: seller,
      now: T0,
      ...overrides,
    });
    if (!made.ok) throw new Error(made.error.code);
    return made.value;
  };

  it('is born pending, new and undecided, with the fields it carries', () => {
    const change = propose({
      proposedDescription: { en: 'x' },
      proposedTagTypes: ['halal'],
    });
    expect(change.state).toMatchObject({
      status: 'pending',
      supersededCause: null,
      decidedAt: null,
      decidedByAccountId: null,
      decisionNote: null,
      submittedAt: T0,
    });
    expect(change.isNew).toBe(true);
    expect(change.decided).toBe(false);
    expect(change.fields).toEqual(['description', 'handling', 'tags']);
  });

  it('refuses an empty change, no reason, a bad handling, a bad or repeated type code', () => {
    const base = {
      id: ids.next<'OfferPendingChange'>(),
      marketId: marketId as MarketId,
      offerId: ids.next<'Offer'>(),
      sellerId: ids.next<'Seller'>(),
      baseOfferVersion: 1,
      reasons: ['review-all' as const],
      policyVersion: 2,
      submittedByAccountId: seller,
      now: T0,
    };
    const invalid = { ok: false, error: { code: 'offer-change.invalid' } };
    expect(OfferPendingChange.propose(base)).toEqual(invalid);
    expect(OfferPendingChange.propose({ ...base, proposedHandling: 'FRESH', reasons: [] })).toEqual(
      invalid,
    );
    expect(OfferPendingChange.propose({ ...base, proposedHandling: 'BOXED' as never })).toEqual(
      invalid,
    );
    expect(OfferPendingChange.propose({ ...base, proposedTagTypes: ['Halal!'] })).toEqual(invalid);
    expect(OfferPendingChange.propose({ ...base, proposedTagTypes: ['halal', 'halal'] })).toEqual(
      invalid,
    );
    expect(
      OfferPendingChange.propose({ ...base, proposedHandling: 'FRESH', baseOfferVersion: 0 }),
    ).toEqual(invalid);
  });

  it('is approved by an admin, with or without a note, once', () => {
    const change = propose();
    expect(change.approve({ accountId: admin, now: T1 })).toEqual({ ok: true, value: undefined });
    expect(change.state).toMatchObject({
      status: 'approved',
      decidedAt: T1,
      decidedByAccountId: admin,
      decisionNote: null,
    });
    expect(change.decided).toBe(true);
    expect(change.approve({ accountId: admin, now: T1 })).toEqual({
      ok: false,
      error: { code: 'offer-change.not-pending' },
    });
  });

  it.each(['requestChanges', 'reject'] as const)(
    '%s needs a note of 1 to 2000 characters',
    (cmd) => {
      const change = propose();
      const refused = { ok: false, error: { code: 'offer-change.note-invalid' } };
      expect(change[cmd]({ accountId: admin, note: '', now: T1 })).toEqual(refused);
      expect(change[cmd]({ accountId: admin, note: '   ', now: T1 })).toEqual(refused);
      expect(
        change[cmd]({ accountId: admin, note: 'x'.repeat(MAX_DECISION_NOTE_CHARS + 1), now: T1 }),
      ).toEqual(refused);
      expect(change.state.status).toBe('pending');
      expect(change[cmd]({ accountId: admin, note: 'Remove the phone number', now: T1 }).ok).toBe(
        true,
      );
      expect(change.state).toMatchObject({
        status: cmd === 'reject' ? 'rejected' : 'changes-requested',
        decisionNote: 'Remove the phone number',
        decidedByAccountId: admin,
      });
    },
  );

  it('is withdrawn by the seller account with no note', () => {
    const change = propose();
    expect(change.withdraw({ accountId: seller, now: T1 }).ok).toBe(true);
    expect(change.state).toMatchObject({
      status: 'withdrawn',
      decidedByAccountId: seller,
      decisionNote: null,
    });
  });

  it.each(['resubmitted', 'offer-deleted'] as const)(
    'is superseded (%s) by the system',
    (cause) => {
      const change = propose();
      expect(change.supersede({ cause, now: T1 }).ok).toBe(true);
      expect(change.state).toMatchObject({
        status: 'superseded',
        supersededCause: cause,
        decidedAt: T1,
        decidedByAccountId: null,
        decisionNote: null,
      });
      expect(change.withdraw({ accountId: seller, now: T1 })).toEqual({
        ok: false,
        error: { code: 'offer-change.not-pending' },
      });
    },
  );

  it('never decides before the submit (clock skew)', () => {
    const change = propose({ now: T1 });
    change.withdraw({ accountId: seller, now: T0 });
    expect(change.state.decidedAt).toEqual(T1);
  });

  it('restores a stored change as not new', () => {
    const change = OfferPendingChange.restore(propose().state);
    expect(change.isNew).toBe(false);
    expect(change.decided).toBe(false);
  });

  it('keeps ids typed', () => {
    const id: Id<'OfferPendingChange'> = propose().state.id;
    expect(typeof id).toBe('string');
  });
});
