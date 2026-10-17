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

  describe('edit', () => {
    const later = T0.add({ hours: 1 });
    const stored = (overrides: Partial<OfferState> = {}) => {
      const created = create();
      if (!created.ok) throw new Error(created.error.code);
      return Offer.restore({ ...created.value.state, version: 3, ...overrides });
    };
    const form = (extra: Record<string, unknown> = {}) => ({
      sellerSku: 'SKU-001',
      conditionCode: 'new',
      description: { 'en-AU': 'Fresh and sealed' },
      now: later,
      ...extra,
    });

    it('stores the changed fields, raises the version by one and leaves a history row', () => {
      const offer = stored();
      const edited = offer.edit(
        form({ sellerSku: 'SKU-002', description: { 'en-AU': 'Fresh', 'ms-MY': 'Segar' } }),
      );
      expect(edited).toEqual({ ok: true, value: ['sellerSku', 'description'] });
      expect(offer.state).toMatchObject({ sellerSku: 'SKU-002', status: 'draft', version: 4 });
      expect(offer.persistedVersion).toBe(3);
      expect(offer.pendingHistory).toEqual({
        changeKind: 'edited',
        changedFields: ['sellerSku', 'description'],
        occurredAt: later,
      });
      expect(offer.pendingEvents).toEqual([]);
    });

    it('stores nothing when a draft form matches what is stored (key order does not matter)', () => {
      const offer = stored({ description: { 'en-AU': 'a', 'ms-MY': 'b' } });
      const edited = offer.edit(form({ description: { 'ms-MY': 'b', 'en-AU': 'a' } }));
      expect(edited).toEqual({ ok: true, value: [] });
      expect(offer.state.version).toBe(3);
      expect(offer.pendingHistory).toBeNull();
    });

    it.each(['pending-first-publish', 'changes-needed'] as const)(
      'returns a %s Offer to draft and leaves the queue, even when nothing changed',
      (status) => {
        const offer = stored({ status, submittedAt: T0, handling: 'FRESH' });
        const edited = offer.edit(form());
        expect(edited).toEqual({ ok: true, value: [] });
        expect(offer.state).toMatchObject({ status: 'draft', submittedAt: null, version: 4 });
        expect(offer.state.handling).toBe('FRESH');
        expect(offer.pendingHistory?.changedFields).toEqual([]);
      },
    );

    it('refuses a deleted Offer', () => {
      const offer = stored({ status: 'deleted', deletedAt: T0 });
      expect(offer.edit(form({ sellerSku: 'SKU-009' }))).toEqual({
        ok: false,
        error: { code: 'offer.not-editable' },
      });
      expect(offer.state.sellerSku).toBe('SKU-001');
      expect(offer.pendingHistory).toBeNull();
    });

    it('edits a published Offer in place: it stays published and listed, no queue (AC 33)', () => {
      const offer = stored({
        status: 'published',
        listed: true,
        handling: 'FRESH',
        submittedAt: T0,
        firstPublishedAt: T0,
      });
      expect(offer.edit(form({ sellerSku: 'SKU-009' }))).toEqual({
        ok: true,
        value: ['sellerSku'],
      });
      expect(offer.state).toMatchObject({
        status: 'published',
        listed: true,
        submittedAt: T0,
        sellerSku: 'SKU-009',
        version: 4,
      });
      expect(offer.pendingHistory).toMatchObject({ changeKind: 'edited' });
      const unchanged = stored({
        status: 'published',
        listed: true,
        handling: 'FRESH',
        firstPublishedAt: T0,
      });
      expect(unchanged.edit(form())).toEqual({ ok: true, value: [] });
      expect(unchanged.hasChanges).toBe(false);
    });

    it('refuses a SKU, condition or description the create rules refuse, and changes nothing', () => {
      const offer = stored();
      expect(offer.edit(form({ sellerSku: 'has space' }))).toEqual({
        ok: false,
        error: { code: 'offer.sku-invalid' },
      });
      expect(offer.edit(form({ conditionCode: 'New!' }))).toEqual({
        ok: false,
        error: { code: 'offer.condition-invalid' },
      });
      expect(offer.edit(form({ description: [] }))).toEqual({
        ok: false,
        error: { code: 'offer.description-invalid' },
      });
      expect(offer.state.version).toBe(3);
      expect(offer.pendingHistory).toBeNull();
    });

    it('keeps the owner, product, handling and attestation', () => {
      const offer = stored({ handling: 'REPACKED' });
      offer.edit(form({ sellerSku: 'SKU-003' }));
      expect(offer.state).toMatchObject({ sellerId, productId, handling: 'REPACKED' });
    });
  });

  describe('submit, approve, request changes and delete', () => {
    const later = T0.add({ hours: 1 });
    const stored = (overrides: Partial<OfferState> = {}) => {
      const created = create();
      if (!created.ok) throw new Error(created.error.code);
      return Offer.restore({
        ...created.value.state,
        handling: 'SEALED_ORIGINAL',
        version: 3,
        ...overrides,
      });
    };
    const waiting = () => stored({ status: 'pending-first-publish', submittedAt: T0, version: 4 });

    it('waits for review when approval is required: pending, stamped, no event', () => {
      const offer = stored();
      expect(offer.submit({ approvalRequired: true, now: later })).toEqual({
        ok: true,
        value: { published: false },
      });
      expect(offer.state).toMatchObject({
        status: 'pending-first-publish',
        submittedAt: later,
        firstPublishedAt: null,
        listed: false,
        version: 4,
      });
      expect(offer.pendingHistory).toEqual({
        changeKind: 'submitted',
        changedFields: [],
        occurredAt: later,
      });
      expect(offer.pendingEvents).toEqual([]);
    });

    it('publishes at once when approval is off: listed, first-published, one event', () => {
      const offer = stored();
      expect(offer.submit({ approvalRequired: false, now: later })).toEqual({
        ok: true,
        value: { published: true },
      });
      expect(offer.state).toMatchObject({
        status: 'published',
        submittedAt: later,
        firstPublishedAt: later,
        listed: true,
        version: 4,
      });
      expect(offer.pendingHistory?.changeKind).toBe('published');
      expect(offer.pendingEvents).toHaveLength(1);
      expect(offer.pendingEvents[0]).toMatchObject({
        type: 'catalog.offer-published.v1',
        aggregateVersion: 4,
        payload: { offerId, productId, sellerId },
      });
    });

    it('refuses a submit without handling or from any state but draft, and changes nothing', () => {
      const noHandling = stored({ handling: null });
      expect(noHandling.submit({ approvalRequired: true, now: later })).toEqual({
        ok: false,
        error: { code: 'offer.handling-missing' },
      });
      for (const status of [
        'pending-first-publish',
        'changes-needed',
        'published',
        'deleted',
      ] as const) {
        const offer = stored({ status, submittedAt: T0, firstPublishedAt: T0, deletedAt: T0 });
        expect(offer.submit({ approvalRequired: false, now: later })).toEqual({
          ok: false,
          error: { code: 'offer.not-submittable' },
        });
        expect(offer.pendingHistory).toBeNull();
        expect(offer.state.version).toBe(3);
      }
    });

    it('approves only an Offer that waits: published, listed, history and event', () => {
      const offer = waiting();
      expect(offer.approve({ now: later })).toEqual({ ok: true, value: undefined });
      expect(offer.state).toMatchObject({
        status: 'published',
        listed: true,
        firstPublishedAt: later,
        submittedAt: T0,
        version: 5,
      });
      expect(offer.pendingHistory?.changeKind).toBe('publication-approved');
      expect(offer.pendingEvents.map((e) => e.type)).toEqual(['catalog.offer-published.v1']);
      for (const status of ['draft', 'changes-needed', 'published', 'deleted'] as const) {
        const other = stored({ status });
        expect(other.approve({ now: later })).toEqual({
          ok: false,
          error: { code: 'offer.not-pending-review' },
        });
      }
    });

    it('sends an Offer that waits back as changes-needed with the reason on the event only', () => {
      const offer = waiting();
      expect(offer.requestChanges({ reasonCode: 'description-claim', now: later })).toEqual({
        ok: true,
        value: undefined,
      });
      expect(offer.state).toMatchObject({ status: 'changes-needed', listed: false, version: 5 });
      expect(offer.pendingHistory).toEqual({
        changeKind: 'changes-requested',
        changedFields: [],
        occurredAt: later,
      });
      expect(offer.pendingEvents[0]).toMatchObject({
        type: 'catalog.offer-changes-requested.v1',
        aggregateVersion: 5,
        payload: { offerId, productId, sellerId, reasonCode: 'description-claim' },
      });
      expect(stored().requestChanges({ reasonCode: 'other', now: later })).toEqual({
        ok: false,
        error: { code: 'offer.not-pending-review' },
      });
    });

    it('lets the seller edit a changes-needed Offer back to draft and submit it again', () => {
      const offer = waiting();
      offer.requestChanges({ reasonCode: 'other', now: later });
      const again = Offer.restore(offer.state);
      expect(
        again.edit({
          sellerSku: 'SKU-009',
          conditionCode: 'new',
          description: { 'en-AU': 'Fresh and sealed' },
          now: later,
        }).ok,
      ).toBe(true);
      expect(again.state.status).toBe('draft');
      expect(Offer.restore(again.state).submit({ approvalRequired: true, now: later }).ok).toBe(
        true,
      );
    });

    it('deletes any Offer that is not deleted: terminal, not listed, one event; refuses twice', () => {
      for (const status of [
        'draft',
        'pending-first-publish',
        'changes-needed',
        'published',
      ] as const) {
        const offer = stored({
          status,
          listed: status === 'published',
          submittedAt: T0,
          firstPublishedAt: status === 'published' ? T0 : null,
        });
        expect(offer.delete({ now: later })).toEqual({ ok: true, value: undefined });
        expect(offer.state).toMatchObject({
          status: 'deleted',
          listed: false,
          deletedAt: later,
          version: 4,
        });
        expect(offer.pendingHistory?.changeKind).toBe('deleted');
        expect(offer.pendingEvents).toMatchObject([
          {
            type: 'catalog.offer-deleted.v1',
            aggregateVersion: 4,
            payload: { offerId, productId, sellerId },
          },
        ]);
      }
      const gone = stored({ status: 'deleted', deletedAt: T0 });
      expect(gone.delete({ now: later })).toEqual({
        ok: false,
        error: { code: 'offer.already-deleted' },
      });
    });

    it('allows one change per read: a second command on the same Offer is a defect', () => {
      const offer = waiting();
      offer.approve({ now: later });
      expect(() => Offer.restore(offer.state).delete({ now: later })).not.toThrow();
      expect(() => offer.delete({ now: later })).toThrow('already has a change');
    });
  });

  describe('recordAttestation (ADR-0012 d4; design 4.4, B1)', () => {
    const later = T0.add({ hours: 2 });
    const accountId = 'a1' as Id<'Account'>;
    const other = 'a2' as Id<'Account'>;
    const stored = (overrides: Partial<OfferState> = {}) => {
      const created = create();
      if (!created.ok) throw new Error(created.error.code);
      return Offer.restore({
        ...created.value.state,
        handling: 'SEALED_ORIGINAL',
        version: 3,
        ...overrides,
      });
    };

    it('records who attested and when on a sealed-original Offer, with its own history kind', () => {
      const offer = stored();
      expect(offer.recordAttestation({ attested: true, accountId, now: later })).toEqual({
        ok: true,
        value: ['attestation'],
      });
      expect(offer.state).toMatchObject({
        attestationRecordedAt: later,
        attestationAccountId: accountId,
        status: 'draft',
        version: 4,
      });
      expect(offer.pendingHistory).toEqual({
        changeKind: 'attestation-recorded',
        changedFields: ['attestation'],
        occurredAt: later,
      });
      expect(offer.pendingEvents).toEqual([]);
    });

    it('withdraws a recorded attestation, clearing both the instant and the author', () => {
      const offer = stored({
        status: 'published',
        listed: true,
        firstPublishedAt: T0,
        submittedAt: T0,
        attestationRecordedAt: T0,
        attestationAccountId: other,
      });
      expect(offer.recordAttestation({ attested: false, accountId, now: later })).toEqual({
        ok: true,
        value: ['attestation'],
      });
      expect(offer.state).toMatchObject({
        attestationRecordedAt: null,
        attestationAccountId: null,
        status: 'published',
        version: 4,
      });
      expect(offer.pendingHistory?.changeKind).toBe('attestation-withdrawn');
    });

    it('keeps the first record when the attestation is recorded again (nothing stored)', () => {
      const offer = stored({ attestationRecordedAt: T0, attestationAccountId: other });
      expect(offer.recordAttestation({ attested: true, accountId, now: later })).toEqual({
        ok: true,
        value: [],
      });
      expect(offer.state).toMatchObject({
        attestationRecordedAt: T0,
        attestationAccountId: other,
        version: 3,
      });
      expect(offer.pendingHistory).toBeNull();
    });

    it('stores nothing when withdrawing an attestation that is not recorded', () => {
      const offer = stored({ handling: 'REPACKED' });
      expect(offer.recordAttestation({ attested: false, accountId, now: later })).toEqual({
        ok: true,
        value: [],
      });
      expect(offer.pendingHistory).toBeNull();
      expect(offer.state.version).toBe(3);
    });

    it('returns a waiting Offer to draft, as any other seller change does', () => {
      const offer = stored({ status: 'pending-first-publish', submittedAt: T0 });
      expect(offer.recordAttestation({ attested: true, accountId, now: later }).ok).toBe(true);
      expect(offer.state).toMatchObject({ status: 'draft', submittedAt: null });
    });

    it.each([null, 'REPACKED', 'PREPARED', 'FRESH'] as const)(
      'refuses to record an attestation when the handling is %s (ADR-0012 d4)',
      (handling) => {
        const offer = stored({ handling });
        expect(offer.recordAttestation({ attested: true, accountId, now: later })).toEqual({
          ok: false,
          error: { code: 'offer.attestation-needs-sealed-original' },
        });
        expect(offer.state.version).toBe(3);
        expect(offer.pendingHistory).toBeNull();
      },
    );

    it.each(['REPACKED', 'PREPARED', 'FRESH'] as const)(
      'clears a recorded attestation when the handling changes away to %s (Hassan M-1)',
      (handling) => {
        const offer = stored({
          status: 'published',
          listed: true,
          firstPublishedAt: T0,
          submittedAt: T0,
          attestationRecordedAt: T0,
          attestationAccountId: other,
        });
        expect(offer.setHandling({ handling, now: later })).toEqual({
          ok: true,
          value: ['handling', 'attestation'],
        });
        expect(offer.state).toMatchObject({
          handling,
          attestationRecordedAt: null,
          attestationAccountId: null,
          status: 'published',
          version: 4,
        });
        expect(offer.pendingHistory).toEqual({
          changeKind: 'edited',
          changedFields: ['handling', 'attestation'],
          occurredAt: later,
        });
        // Back to SEALED_ORIGINAL: the attestation is not revived; a new record is needed.
        const back = Offer.restore(offer.state);
        expect(back.setHandling({ handling: 'SEALED_ORIGINAL', now: later })).toEqual({
          ok: true,
          value: ['handling'],
        });
        expect(back.state.attestationRecordedAt).toBeNull();
      },
    );

    it('keeps the attestation when the handling is set to the value it already holds', () => {
      const offer = stored({ attestationRecordedAt: T0, attestationAccountId: other });
      expect(offer.setHandling({ handling: 'SEALED_ORIGINAL', now: later })).toEqual({
        ok: true,
        value: [],
      });
      expect(offer.state).toMatchObject({
        attestationRecordedAt: T0,
        attestationAccountId: other,
        version: 3,
      });
      expect(offer.pendingHistory).toBeNull();
    });

    it('changes only the handling when no attestation is recorded', () => {
      const offer = stored();
      expect(offer.setHandling({ handling: 'FRESH', now: later })).toEqual({
        ok: true,
        value: ['handling'],
      });
      expect(offer.pendingHistory?.changedFields).toEqual(['handling']);
    });

    it('refuses a deleted Offer', () => {
      const offer = stored({ status: 'deleted', deletedAt: T0 });
      expect(offer.recordAttestation({ attested: false, accountId, now: later })).toEqual({
        ok: false,
        error: { code: 'offer.not-editable' },
      });
    });
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
