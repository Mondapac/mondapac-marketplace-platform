import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { OFF_SALE_CAUSES, Offer, isListed, type OfferState } from './offer';

// The Offer aggregate is Market-agnostic: both fixtures run the same rules (a test that only
// passes for AU is a bug).
const MARKETS = ['AU', 'ZZ'] as const;
const T0 = Temporal.Instant.from('2026-10-09T00:00:00Z');
const offerId = 'o1' as Id<'Offer'>;
const productId = 'p1' as Id<'Product'>;
const sellerId = 's1' as Id<'Seller'>;

describe.each(MARKETS)('Offer in market %s', (code) => {
  const marketId = code as MarketId;
  const create = (overrides: Partial<Parameters<typeof Offer.create>[0]> = {}) =>
    Offer.create({
      id: offerId,
      marketId,
      sellerId,
      productId,
      sellerSku: 'SKU-001',
      conditionCode: 'new',
      description: { 'en-AU': 'Fresh and sealed' },
      now: T0,
      ...overrides,
    });

  it('starts as a draft with no handling, attestation, cause or listing', () => {
    const created = create();
    if (!created.ok) throw new Error(created.error.code);
    const state = created.value.state;
    expect(state).toMatchObject({
      id: offerId,
      marketId,
      sellerId,
      productId,
      sellerSku: 'SKU-001',
      conditionCode: 'new',
      status: 'draft',
      handling: null,
      attestationRecordedAt: null,
      attestationAccountId: null,
      offSaleCauses: [],
      listed: false,
      submittedAt: null,
      firstPublishedAt: null,
      deletedAt: null,
      version: 1,
      createdAt: T0,
    });
    expect(state.description).toEqual({ 'en-AU': 'Fresh and sealed' });
    expect(created.value.persistedVersion).toBeNull();
  });

  it('records exactly one offer-created event with ids only, at version 1', () => {
    const created = create();
    if (!created.ok) throw new Error(created.error.code);
    const events = created.value.pendingEvents;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'catalog.offer-created.v1',
      aggregateId: offerId,
      aggregateVersion: 1,
      payload: { offerId, productId, sellerId },
    });
  });

  it.each(['', ' sku', 'a b', 'tab\t', 'x'.repeat(65), 'sku\n', 'ключ'])(
    'refuses the seller SKU %j',
    (sellerSku) => {
      expect(create({ sellerSku })).toEqual({ ok: false, error: { code: 'offer.sku-invalid' } });
    },
  );

  it.each(['A', 'a-b_c.1/2', 'x'.repeat(64)])('accepts the seller SKU %j', (sellerSku) => {
    expect(create({ sellerSku }).ok).toBe(true);
  });

  it.each([[null], [[]], ['text'], [{ 'en-AU': 5 }], [{ '': 'x' }]])(
    'refuses the description %j',
    (description) => {
      expect(create({ description: description as never })).toEqual({
        ok: false,
        error: { code: 'offer.description-invalid' },
      });
    },
  );

  it('allows an empty description object in a draft (OFR-04 allows an incomplete draft)', () => {
    expect(create({ description: {} }).ok).toBe(true);
  });

  it('refuses a condition code that is not a vocabulary code', () => {
    expect(create({ conditionCode: 'New Item' })).toEqual({
      ok: false,
      error: { code: 'offer.condition-invalid' },
    });
  });

  it('restores a stored Offer without events, keeping its persisted version', () => {
    const created = create();
    if (!created.ok) throw new Error(created.error.code);
    const restored = Offer.restore({ ...created.value.state, version: 4 });
    expect(restored.persistedVersion).toBe(4);
    expect(restored.pendingEvents).toEqual([]);
  });

  it('freezes its state', () => {
    const created = create();
    if (!created.ok) throw new Error(created.error.code);
    expect(Object.isFrozen(created.value.state)).toBe(true);
  });
});

describe('isListed (data design 3.13: listed = published and no cause)', () => {
  const base: Pick<OfferState, 'status' | 'offSaleCauses'> = {
    status: 'published',
    offSaleCauses: [],
  };
  it('is true only for a published Offer with no cause', () => {
    expect(isListed(base)).toBe(true);
    for (const status of ['draft', 'pending-first-publish', 'changes-needed', 'deleted'] as const) {
      expect(isListed({ ...base, status })).toBe(false);
    }
    for (const cause of OFF_SALE_CAUSES) {
      expect(isListed({ ...base, offSaleCauses: [cause] })).toBe(false);
    }
  });
});
