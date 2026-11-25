import { describe, expect, it } from 'vitest';
import { bulkApprovalCheck, stopsOf, type FirstRow } from './types.ts';

const row = (over: Partial<FirstRow>): FirstRow => ({
  kind: 'offer-first-publication',
  offerId: 'o1',
  version: 1,
  sellerId: 's1',
  storeName: 'Store',
  productId: 'p1',
  product: { productCode: 'P', typeCode: 'grocery', name: 'Dates' },
  sellerSku: 'SKU',
  conditionCode: 'new',
  description: {},
  handling: null,
  reasons: ['probation'],
  tagTypes: [],
  submittedAt: null,
  actions: ['approve'],
  ...over,
});

describe('bulkApprovalCheck', () => {
  it('allows probation and watched-seller rows', () => {
    expect(bulkApprovalCheck([row({}), row({ reasons: ['full-review'] })]).ok).toBe(true);
  });
  it('names the reasons that need a single look', () => {
    expect(bulkApprovalCheck([row({}), row({ reasons: ['handling', 'contact-text'] })])).toEqual({
      ok: false,
      why: 'reasons',
      codes: ['handling', 'contact-text'],
    });
  });
  it('refuses rows with no stored reason', () => {
    expect(bulkApprovalCheck([row({ reasons: [] })]).ok).toBe(false);
  });
  it('needs one seller and one certificate type for certificate rows', () => {
    const badge = (over: Partial<FirstRow>) =>
      row({ reasons: ['certificate-badge'], tagTypes: ['halal'], ...over });
    expect(bulkApprovalCheck([badge({}), badge({ offerId: 'o2' })])).toEqual({
      ok: true,
      certificate: 'halal',
      sellerId: 's1',
    });
    expect(bulkApprovalCheck([badge({}), badge({ sellerId: 's2' })])).toMatchObject({
      ok: false,
      why: 'certificate-mixed',
    });
    expect(bulkApprovalCheck([badge({}), badge({ tagTypes: ['kosher'] })])).toMatchObject({
      ok: false,
      why: 'certificate-mixed',
    });
  });
});

describe('stopsOf', () => {
  it('reads the counts and nulls what was not read', () => {
    expect(
      stopsOf({ marketStop: false, stoppedSellers: 2, stoppedCategories: null, active: true }),
    ).toEqual({ marketStop: false, stoppedSellers: 2, stoppedCategories: null, active: true });
    expect(stopsOf({})).toBeNull();
    expect(stopsOf(null)).toBeNull();
  });
});
