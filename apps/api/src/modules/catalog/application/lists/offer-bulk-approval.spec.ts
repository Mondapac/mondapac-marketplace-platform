import type { OfferReviewReason } from '../../domain/offer-review-policy';
import { bulkOfferApprovalVerdicts, type BulkOfferFacts } from './offer-bulk-approval';

const row = (
  offerId: string,
  reasons: readonly string[] | null,
  extra: Partial<BulkOfferFacts> = {},
): BulkOfferFacts => ({
  offerId,
  sellerId: 'seller-a',
  reasons: reasons as readonly OfferReviewReason[] | null,
  tagTypes: [],
  stopped: false,
  ...extra,
});

describe('bulkOfferApprovalVerdicts (pure, ADR-0051 slice 5 rules R1, R6, R2)', () => {
  it('fails closed on a reason code the policy does not know, even next to an allowed one', () => {
    const verdicts = bulkOfferApprovalVerdicts([
      row('a', ['zz-future-reason']),
      row('b', ['probation', 'zz-future-reason']),
    ]);
    expect(verdicts.get('a')).toEqual({
      allowed: false,
      reason: 'review.bulk-not-allowed',
      blockers: ['zz-future-reason'],
    });
    expect(verdicts.get('b')).toEqual({
      allowed: false,
      reason: 'review.bulk-not-allowed',
      blockers: ['zz-future-reason'],
    });
  });

  it('fails closed on null and on an empty reason list', () => {
    const verdicts = bulkOfferApprovalVerdicts([row('a', null), row('b', [])]);
    for (const id of ['a', 'b']) {
      expect(verdicts.get(id)).toEqual({
        allowed: false,
        reason: 'review.reasons-unknown',
        blockers: [],
      });
    }
  });

  it('skips an R2 row that asks no certificate type at all (cannot name one certificate)', () => {
    const verdicts = bulkOfferApprovalVerdicts([row('a', ['certificate-badge'], { tagTypes: [] })]);
    expect(verdicts.get('a')).toMatchObject({
      allowed: false,
      reason: 'review.bulk-certificate-mixed',
    });
  });

  it('lets a lone R2 row of one type pass and a row blocked by R3 never join the R2 group', () => {
    const verdicts = bulkOfferApprovalVerdicts([
      row('a', ['certificate-badge'], { tagTypes: ['halal'] }),
      row('b', ['certificate-badge', 'handling'], { tagTypes: ['vegan'], sellerId: 'seller-b' }),
    ]);
    expect(verdicts.get('a')).toEqual({ allowed: true });
    expect(verdicts.get('b')).toMatchObject({ allowed: false, reason: 'review.bulk-not-allowed' });
  });

  it('skips a row whose stop is on now, whatever its stored reasons (Hassan M1)', () => {
    const verdicts = bulkOfferApprovalVerdicts([
      row('a', ['probation'], { stopped: true }),
      row('b', ['certificate-badge'], { stopped: true, tagTypes: ['halal'] }),
      row('c', ['probation', 'handling', 'emergency-stop'], { stopped: true }),
      row('d', null, { stopped: true }),
      row('e', ['certificate-badge'], { tagTypes: ['halal'], sellerId: 'seller-b' }),
    ]);
    for (const id of ['a', 'b', 'd']) {
      expect(verdicts.get(id)).toEqual({
        allowed: false,
        reason: 'review.bulk-not-allowed',
        blockers: ['emergency-stop'],
      });
    }
    expect(verdicts.get('c')).toEqual({
      allowed: false,
      reason: 'review.bulk-not-allowed',
      blockers: ['emergency-stop', 'handling'],
    });
    // A stopped R2 row never joins the R2 group: the other seller's lone R2 row still passes.
    expect(verdicts.get('e')).toEqual({ allowed: true });
  });

  it('never allows R0, R3, R5, R7 or review-all', () => {
    for (const reason of [
      'emergency-stop',
      'handling',
      'contact-text',
      'sensitive-category',
      'review-all',
    ]) {
      expect(bulkOfferApprovalVerdicts([row('a', [reason])]).get('a')).toMatchObject({
        allowed: false,
        blockers: [reason],
      });
    }
  });
});
