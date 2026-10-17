import { Temporal } from '@mondapac/shared-kernel';
import type { MarketId } from '@mondapac/shared-kernel';
import { FixedClock, SequenceIdGenerator } from '@mondapac/shared-kernel/testing';
import { Offer, type OfferState } from './offer';
import {
  canonicalClaimInputs,
  claimQueriesFor,
  judgeTag,
  type ClaimFacts,
  type TagActor,
  type TagClaimQuery,
  type TagDecision,
} from './offer-tag';

// Certification tags on Offers (catalog design 5.1 to 5.4; AC 7 to 11, 14, 15): the verdict on
// the decisions of every variant, the equality of returned inputs with the state being saved,
// and the tag statuses. Run on both Market fixtures with each Market's own type code (AC 18).

const T0 = Temporal.Instant.from('2026-10-17T00:00:00Z');
const T1 = Temporal.Instant.from('2026-10-17T01:00:00Z');
const hash = (text: string): string => text.length.toString(16).padStart(64, '0');

describe.each([
  ['AU', 'halal'],
  ['ZZ', 'zz-cert'],
] as const)('offer tags in market %s', (code, typeCode) => {
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const sellerId = ids.next<'Seller'>();
  const productId = ids.next<'Product'>();
  const revisionId = ids.next<'ProductRevision'>();
  const variants = [ids.next<'Variant'>(), ids.next<'Variant'>()];
  const paths = [[ids.next<'Category'>(), ids.next<'Category'>()]];
  const certificateId = ids.next();
  const versionId = ids.next();
  const typeRevisionId = ids.next();
  const seller: TagActor = { kind: 'seller', accountId: ids.next<'Account'>() };

  const facts = (overrides: Partial<ClaimFacts> = {}): ClaimFacts => ({
    productId,
    productRevisionId: revisionId,
    revisionPublished: true,
    variantIds: variants,
    platformCategoryPaths: paths,
    ...overrides,
  });

  const offerState = (overrides: Partial<OfferState> = {}): OfferState => ({
    id: ids.next<'Offer'>(),
    marketId: code as MarketId,
    sellerId,
    productId,
    sellerSku: 'SKU-1',
    conditionCode: 'new',
    description: {},
    handling: 'SEALED_ORIGINAL',
    attestationRecordedAt: null,
    attestationAccountId: null,
    status: 'published',
    offSaleCauses: [],
    listed: true,
    submittedAt: T0,
    firstPublishedAt: T0,
    deletedAt: null,
    version: 4,
    createdAt: T0,
    ...overrides,
  });

  const allowed = (query: TagClaimQuery, overrides: Partial<TagDecision> = {}): TagDecision => ({
    allowed: true,
    basis: 'SELLER',
    reason: 'allowed',
    certificate: {
      kind: 'seller',
      certificateId,
      versionId,
      issuerId: null,
      typeRevisionId,
      validUntil: null,
    },
    policyRevisionId: null,
    badge: {
      typeCode: query.typeCode,
      typeRevisionId,
      basis: 'SELLER',
      sellerClaim: true,
      issuer: null,
      validUntilLocalDate: null,
      validUntilZone: null,
      verifiedWithIssuer: false,
      reviewedByPlatform: true,
    },
    inputs: query,
    evaluatedAt: T1,
    ...overrides,
  });

  const refused = (query: TagClaimQuery, reason: string): TagDecision => ({
    allowed: false,
    basis: null,
    reason,
    certificate: null,
    policyRevisionId: null,
    badge: null,
    inputs: query,
    evaluatedAt: T1,
  });

  const queriesOf = (offer: Offer, f: ClaimFacts = facts(), type: string = typeCode) =>
    claimQueriesFor(offer.state, f, type)!;

  const answer = (
    offer: Offer,
    decide: (q: TagClaimQuery, i: number) => TagDecision = (q) => allowed(q),
    f: ClaimFacts = facts(),
  ) => new Map([[typeCode, queriesOf(offer, f).map(decide)]]);

  const add = (offer: Offer, decisions = answer(offer), f: ClaimFacts = facts()) =>
    offer.addTags({
      tags: [{ tagId: ids.next<'OfferTag'>(), typeCode }],
      facts: f,
      decisions,
      entryPath: 'tag-add',
      actor: seller,
      hash,
      now: T1,
    });

  const withActiveTag = (overrides: Partial<OfferState> = {}): Offer => {
    const offer = Offer.restore(offerState(overrides));
    expect(add(offer).ok).toBe(true);
    return Offer.restore(offer.state, offer.tags);
  };

  describe('claimQueriesFor and judgeTag', () => {
    it('builds one query per variant from the stored Offer and the facts only', () => {
      const offer = Offer.restore(offerState({ attestationRecordedAt: T0 }));
      const queries = queriesOf(offer);
      expect(queries).toHaveLength(2);
      expect(queries[1]).toEqual({
        sellerId,
        productId,
        productRevisionId: revisionId,
        variantId: variants[1],
        typeCode,
        handling: 'SEALED_ORIGINAL',
        attestationRecorded: true,
        platformCategoryPaths: paths,
      });
    });

    it('asks nothing without handling, and refuses facts of another product', () => {
      const offer = Offer.restore(offerState({ handling: null, status: 'draft', listed: false }));
      expect(claimQueriesFor(offer.state, facts(), typeCode)).toBeNull();
      const other = Offer.restore(offerState({ productId: ids.next<'Product'>() }));
      expect(() => claimQueriesFor(other.state, facts(), typeCode)).toThrow();
    });

    it('allows only when every variant is allowed on one certificate (AC 15)', () => {
      const expected = queriesOf(Offer.restore(offerState()));
      expect(
        judgeTag(
          expected,
          expected.map((q) => allowed(q)),
        ),
      ).toMatchObject({
        kind: 'allowed',
        copy: { basis: 'SELLER', certificateId, certificateVersionId: versionId },
      });
      expect(
        judgeTag(expected, [allowed(expected[0]!), refused(expected[1]!, 'not-covered')]),
      ).toEqual({ kind: 'not-allowed', reason: 'not-covered', evaluatedAt: T1 });
      const otherVersion = allowed(expected[1]!, {
        certificate: { ...allowed(expected[1]!).certificate!, versionId: ids.next() },
      });
      expect(judgeTag(expected, [allowed(expected[0]!), otherVersion])).toMatchObject({
        kind: 'not-allowed',
        reason: 'not-covered',
      });
    });

    it('is stale when a returned input differs from the state being saved (AC 9)', () => {
      const expected = queriesOf(Offer.restore(offerState()));
      const changed = [
        { ...expected[0]!, handling: 'PREPARED' as const },
        { ...expected[0]!, sellerId: ids.next<'Seller'>() },
        { ...expected[0]!, attestationRecorded: true },
        { ...expected[0]!, productRevisionId: ids.next<'ProductRevision'>() },
        { ...expected[0]!, platformCategoryPaths: [[paths[0]![1]!, paths[0]![0]!]] },
      ];
      for (const inputs of changed) {
        expect(
          judgeTag(expected, [allowed(expected[0]!, { inputs }), allowed(expected[1]!)]),
        ).toEqual({ kind: 'stale' });
      }
      expect(judgeTag(expected, [allowed(expected[0]!)])).toEqual({ kind: 'stale' });
      expect(judgeTag(expected, undefined)).toEqual({ kind: 'stale' });
    });

    it('fails closed on unavailable, a missing badge or a badge of another type', () => {
      const expected = queriesOf(Offer.restore(offerState()));
      expect(
        judgeTag(expected, [allowed(expected[0]!), refused(expected[1]!, 'unavailable')]),
      ).toEqual({ kind: 'unavailable' });
      expect(
        judgeTag(
          expected,
          expected.map((q) => allowed(q, { badge: null })),
        ),
      ).toMatchObject({ kind: 'not-allowed', reason: 'not-covered' });
      const foreign = allowed(expected[0]!).badge!;
      expect(
        judgeTag(
          expected,
          expected.map((q) => allowed(q, { badge: { ...foreign, typeCode: 'other-type' } })),
        ),
      ).toMatchObject({ kind: 'not-allowed' });
      expect(
        judgeTag(expected, [allowed(expected[0]!, { inputs: null }), allowed(expected[1]!)]),
      ).toEqual({ kind: 'unavailable' });
    });

    it('hashes the inputs a tag was decided on, not the type', () => {
      const offer = Offer.restore(offerState());
      expect(canonicalClaimInputs(queriesOf(offer))).toBe(
        canonicalClaimInputs(queriesOf(offer, facts(), 'other-type')),
      );
      expect(() => canonicalClaimInputs([])).toThrow();
    });
  });

  describe('judgeTag answer shape (Hassan I2)', () => {
    it('treats an allowed answer without reason allowed, or the reverse, as unavailable', () => {
      const offer = Offer.restore(offerState(), []);
      const queries = queriesOf(offer);
      expect(
        judgeTag(
          queries,
          queries.map((q) => allowed(q, { reason: 'no-certificate' })),
        ),
      ).toEqual({ kind: 'unavailable' });
      expect(
        judgeTag(
          queries,
          queries.map((q) => ({ ...refused(q, 'allowed') })),
        ),
      ).toEqual({ kind: 'unavailable' });
    });

    it('refuses as not-covered when the variants carry different badges or issuers', () => {
      const offer = Offer.restore(offerState(), []);
      const queries = queriesOf(offer);
      const otherBadge = judgeTag(
        queries,
        queries.map((q, i) =>
          i === 0
            ? allowed(q)
            : allowed(q, { badge: { ...allowed(q).badge!, verifiedWithIssuer: true } }),
        ),
      );
      expect(otherBadge).toMatchObject({ kind: 'not-allowed', reason: 'not-covered' });
      const otherIssuer = judgeTag(
        queries,
        queries.map((q, i) =>
          i === 0
            ? allowed(q)
            : allowed(q, { certificate: { ...allowed(q).certificate!, issuerId: ids.next() } }),
        ),
      );
      expect(otherIssuer).toMatchObject({ kind: 'not-allowed', reason: 'not-covered' });
    });

    it('answers every variant input-invalid as a refusal, never a fault (I3)', () => {
      const offer = Offer.restore(offerState(), []);
      const queries = queriesOf(offer);
      const invalid = queries.map((q) => ({ ...refused(q, 'input-invalid'), inputs: null }));
      expect(judgeTag(queries, invalid)).toMatchObject({
        kind: 'not-allowed',
        reason: 'input-invalid',
      });
      expect(add(offer, new Map([[typeCode, invalid]]))).toMatchObject({
        error: { code: 'claim.tag-not-allowed', tags: [{ typeCode, reason: 'input-invalid' }] },
      });
    });
  });

  describe('read-only projections (I1)', () => {
    it('marks an Offer restored without tags as not saveable, and one with tags as saveable', () => {
      expect(Offer.restore(offerState()).tagsLoaded).toBe(false);
      expect(Offer.restore(offerState(), []).tagsLoaded).toBe(true);
    });
  });

  describe('Offer.addTags', () => {
    it('adds an active tag with its copy, badge, history row and event (AC 7, 14)', () => {
      const offer = Offer.restore(offerState());
      expect(add(offer)).toEqual({ ok: true, value: undefined });
      const [tag] = offer.tags;
      expect(tag).toMatchObject({
        typeCode,
        status: 'active',
        changeSeq: 1,
        copy: { basis: 'SELLER', certificateKind: 'seller', certificateVersionId: versionId },
        copyRevisionId: revisionId,
        copyRevisionPublished: true,
        lastReasonCode: 'allowed',
        lastChangeCause: 'tag-add',
      });
      expect(tag!.badge).toMatchObject({ typeCode, basis: 'SELLER' });
      expect(tag!.inputsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(offer.pendingTagHistory).toEqual([
        expect.objectContaining({ fromStatus: null, toStatus: 'active', entryPath: 'tag-add' }),
      ]);
      expect(offer.pendingEvents.map((e) => [e.type, e.aggregateVersion])).toEqual([
        ['catalog.offer-tag-added.v1', 5],
      ]);
      expect(offer.state.version).toBe(5);
      expect(offer.pendingHistory).toBeNull();
      expect(offer.pendingTagChanges.added).toEqual([tag!.id]);
    });

    it('refuses a type the seller does not hold, naming the reason, storing nothing (AC 7)', () => {
      const offer = Offer.restore(offerState());
      const outcome = add(
        offer,
        answer(offer, (q) => refused(q, 'no-valid-seller-certificate')),
      );
      expect(outcome).toEqual({
        ok: false,
        error: {
          code: 'claim.tag-not-allowed',
          tags: [{ typeCode, reason: 'no-valid-seller-certificate' }],
        },
      });
      expect(offer.tags).toEqual([]);
      expect(offer.hasChanges).toBe(false);
    });

    it('refuses a tag allowed for one variant only (AC 15)', () => {
      const offer = Offer.restore(offerState());
      const outcome = add(
        offer,
        answer(offer, (q, i) => (i === 0 ? allowed(q) : refused(q, 'not-covered'))),
      );
      expect(outcome).toMatchObject({ ok: false, error: { code: 'claim.tag-not-allowed' } });
      expect(offer.tags).toEqual([]);
    });

    it('refuses unavailable and stale answers, a second tag of a type and an Offer without handling', () => {
      const offer = Offer.restore(offerState());
      expect(
        add(
          offer,
          answer(offer, (q) => refused(q, 'unavailable')),
        ),
      ).toMatchObject({
        error: { code: 'claim.check-unavailable' },
      });
      expect(
        add(
          offer,
          answer(offer, (q) => allowed(q, { inputs: { ...q, handling: 'FRESH' } })),
        ),
      ).toMatchObject({ error: { code: 'claim.inputs-changed' } });
      expect(add(offer, new Map())).toMatchObject({ error: { code: 'claim.inputs-changed' } });
      const tagged = withActiveTag();
      expect(add(tagged)).toMatchObject({ error: { code: 'tag.exists' } });
      const draft = Offer.restore(offerState({ handling: null, status: 'draft', listed: false }));
      expect(add(draft, new Map())).toMatchObject({ error: { code: 'offer.handling-missing' } });
      expect(add(offer, answer(offer), facts({ revisionPublished: false }))).toMatchObject({
        error: { code: 'tag.product-not-published' },
      });
    });
  });

  describe('Offer.settleTags (ask on every write)', () => {
    const settle = (offer: Offer, decide: (q: TagClaimQuery, i: number) => TagDecision) =>
      offer.settleTags({
        facts: facts(),
        decisions: answer(offer, decide),
        entryPath: 'offer-edit',
        actor: seller,
        hash,
        now: T1,
      });

    it('suspends a kept tag that is no longer allowed and takes the Offer off sale (AC 11)', () => {
      const offer = withActiveTag();
      const version = offer.state.version;
      expect(settle(offer, (q) => refused(q, 'no-valid-seller-certificate'))).toEqual({
        ok: true,
        value: { kept: 0, suspended: 1, restored: 0, switched: 0 },
      });
      expect(offer.tags[0]).toMatchObject({
        status: 'suspended',
        badge: null,
        changeSeq: 2,
        lastReasonCode: 'no-valid-seller-certificate',
        lastChangeCause: 'offer-edit',
      });
      expect(offer.state).toMatchObject({ offSaleCauses: ['tag-suspended'], listed: false });
      expect(offer.pendingHistory).toMatchObject({ changeKind: 'causes-changed' });
      expect(offer.pendingEvents.map((e) => [e.type, e.aggregateVersion])).toEqual([
        ['catalog.offer-tag-suspended.v1', version + 1],
        ['catalog.offer-listing-changed.v1', version + 2],
      ]);
      expect(offer.pendingTagHistory).toEqual([
        expect.objectContaining({ fromStatus: 'active', toStatus: 'suspended', changeSeq: 2 }),
      ]);
    });

    it('restores a suspended tag only on a fresh allowed decision', () => {
      const offer = withActiveTag();
      settle(offer, (q) => refused(q, 'no-valid-seller-certificate'));
      const suspended = Offer.restore(offer.state, offer.tags);
      expect(settle(suspended, (q) => allowed(q))).toMatchObject({ value: { restored: 1 } });
      expect(suspended.tags[0]).toMatchObject({ status: 'active', changeSeq: 3 });
      expect(suspended.tags[0]!.badge).not.toBeNull();
      expect(suspended.state).toMatchObject({ offSaleCauses: [], listed: true });
      expect(suspended.pendingEvents.map((e) => e.type)).toEqual([
        'catalog.offer-tag-restored.v1',
        'catalog.offer-listing-changed.v1',
      ]);
    });

    it('keeps an allowed tag with an unchanged copy: no history row, no event, same change_seq', () => {
      const offer = withActiveTag();
      expect(settle(offer, (q) => allowed(q))).toMatchObject({ value: { kept: 1 } });
      expect(offer.pendingTagHistory).toEqual([]);
      expect(offer.pendingEvents).toEqual([]);
      expect(offer.tags[0]!.changeSeq).toBe(1);
      expect(offer.hasChanges).toBe(true);
    });

    it('writes a history row for a basis switch (change_seq + 1) and announces it (F1)', () => {
      const again = withActiveTag();
      const manufacturer = (q: TagClaimQuery) =>
        allowed(q, {
          basis: 'MANUFACTURER',
          certificate: { ...allowed(q).certificate!, kind: 'manufacturer' },
          badge: { ...allowed(q).badge!, basis: 'MANUFACTURER', sellerClaim: false },
        });
      expect(settle(again, manufacturer)).toMatchObject({ value: { switched: 1 } });
      expect(again.pendingEvents.map((e) => e.type)).toEqual([
        'catalog.offer-tag-basis-switched.v1',
      ]);
      expect(again.pendingTagHistory).toEqual([
        expect.objectContaining({
          fromStatus: 'active',
          toStatus: 'active',
          changeSeq: 2,
          copy: expect.objectContaining({ basis: 'MANUFACTURER' }) as unknown,
        }),
      ]);
      expect(again.tags[0]).toMatchObject({ changeSeq: 2, copy: { basis: 'MANUFACTURER' } });
    });

    it('writes a history row for a new certificate version on the same basis (M4)', () => {
      const offer = withActiveTag();
      const newVersion = ids.next();
      const renewed = (q: TagClaimQuery) =>
        allowed(q, { certificate: { ...allowed(q).certificate!, versionId: newVersion } });
      expect(settle(offer, renewed)).toMatchObject({ value: { kept: 1 } });
      expect(offer.pendingEvents).toEqual([]);
      expect(offer.pendingTagHistory).toEqual([
        expect.objectContaining({
          fromStatus: 'active',
          toStatus: 'active',
          changeSeq: 2,
          copy: expect.objectContaining({ certificateVersionId: newVersion }) as unknown,
        }),
      ]);
    });

    it('changes nothing on an unavailable or stale answer (fail closed)', () => {
      const offer = withActiveTag();
      expect(settle(offer, (q) => refused(q, 'unavailable'))).toMatchObject({
        error: { code: 'claim.check-unavailable' },
      });
      expect(
        settle(offer, (q) => allowed(q, { inputs: { ...q, attestationRecorded: true } })),
      ).toMatchObject({ error: { code: 'claim.inputs-changed' } });
      expect(offer.hasChanges).toBe(false);
      expect(offer.tags[0]!.status).toBe('active');
    });

    it('asks nothing and changes nothing for an Offer without kept tags', () => {
      const offer = Offer.restore(offerState());
      expect(
        offer.settleTags({
          facts: null,
          decisions: new Map(),
          entryPath: 'offer-edit',
          actor: seller,
          hash,
          now: T1,
        }),
      ).toEqual({ ok: true, value: { kept: 0, suspended: 0, restored: 0, switched: 0 } });
      expect(offer.hasChanges).toBe(false);
    });

    it('re-asks after a handling change against the new handling (AC 11)', () => {
      const offer = withActiveTag();
      expect(offer.setHandling({ handling: 'PREPARED', now: T1 }).ok).toBe(true);
      expect(offer.state.status).toBe('published');
      const stale = settle(offer, (q) =>
        allowed(q, { inputs: { ...q, handling: 'SEALED_ORIGINAL' } }),
      );
      expect(stale).toMatchObject({ error: { code: 'claim.inputs-changed' } });
      expect(settle(offer, (q) => refused(q, 'handling-requires-seller')).ok).toBe(true);
      expect(offer.tags[0]!.status).toBe('suspended');
      expect(offer.pendingHistory).toMatchObject({
        changeKind: 'edited',
        changedFields: ['handling'],
      });
    });
  });

  describe('first-submit requests and removal', () => {
    const pendingFacts = () => facts({ revisionPublished: false });
    const request = (
      offer: Offer,
      types: readonly string[],
      decide = (q: TagClaimQuery) => allowed(q),
    ) =>
      offer.setPendingPublishTags({
        tags: types.map((type) => ({ tagId: ids.next<'OfferTag'>(), typeCode: type })),
        facts: pendingFacts(),
        decisions: new Map(
          types.map((type) => [
            type,
            claimQueriesFor(offer.state, pendingFacts(), type)!.map(decide),
          ]),
        ),
        entryPath: 'revision-submit',
        actor: seller,
        hash,
        now: T1,
      });

    const draft = () =>
      Offer.restore(offerState({ status: 'draft', listed: false, firstPublishedAt: null }));

    it('writes requested types pending-publish without badge data or events (5.1a points 2, 6)', () => {
      const offer = draft();
      expect(request(offer, [typeCode])).toEqual({ ok: true, value: undefined });
      expect(offer.tags[0]).toMatchObject({
        status: 'pending-publish',
        badge: null,
        copyRevisionPublished: false,
        copyRevisionId: revisionId,
        lastChangeCause: 'revision-submit',
      });
      expect(offer.pendingEvents).toEqual([]);
      expect(offer.state.listed).toBe(false);
    });

    it('refuses the whole request when one type is not allowed', () => {
      const offer = draft();
      expect(request(offer, [typeCode], (q) => refused(q, 'policy-not-applicable'))).toEqual({
        ok: false,
        error: {
          code: 'claim.tag-not-allowed',
          tags: [{ typeCode, reason: 'policy-not-applicable' }],
        },
      });
      expect(offer.tags).toEqual([]);
    });

    it('makes the pending set exactly the requested one at a later submit', () => {
      const offer = draft();
      request(offer, [typeCode]);
      const next = Offer.restore(offer.state, offer.tags);
      expect(request(next, [])).toEqual({ ok: true, value: undefined });
      expect(next.tags[0]).toMatchObject({ status: 'removed', removedByKind: 'seller' });
      expect(next.pendingTagHistory).toEqual([
        expect.objectContaining({ fromStatus: 'pending-publish', toStatus: 'removed' }),
      ]);
    });

    it('writes a history row when a kept pending tag takes the copy of a new frozen revision (F1)', () => {
      const offer = draft();
      request(offer, [typeCode]);
      const next = Offer.restore(offer.state, offer.tags);
      const newer = facts({
        revisionPublished: false,
        productRevisionId: ids.next<'ProductRevision'>(),
      });
      expect(
        next.setPendingPublishTags({
          tags: [{ tagId: ids.next<'OfferTag'>(), typeCode }],
          facts: newer,
          decisions: new Map([
            [typeCode, claimQueriesFor(next.state, newer, typeCode)!.map((q) => allowed(q))],
          ]),
          entryPath: 'revision-submit',
          actor: seller,
          hash,
          now: T1,
        }),
      ).toEqual({ ok: true, value: undefined });
      expect(next.tags[0]).toMatchObject({
        status: 'pending-publish',
        changeSeq: 2,
        copyRevisionId: newer.productRevisionId,
      });
      expect(next.pendingTagHistory).toEqual([
        expect.objectContaining({
          fromStatus: 'pending-publish',
          toStatus: 'pending-publish',
          changeSeq: 2,
          copyRevisionId: newer.productRevisionId,
        }),
      ]);
    });

    it('refuses facts of a published revision (never the working copy or a published one)', () => {
      const offer = draft();
      expect(() =>
        offer.setPendingPublishTags({
          tags: [],
          facts: facts(),
          decisions: new Map(),
          entryPath: 'revision-submit',
          actor: seller,
          hash,
          now: T1,
        }),
      ).toThrow();
    });

    it('lets a seller remove an active tag, and refuses a suspended or missing one', () => {
      const offer = withActiveTag();
      expect(offer.removeTag({ typeCode, actor: seller, now: T1 }).ok).toBe(true);
      expect(offer.tags[0]).toMatchObject({
        status: 'removed',
        removedByAccountId: seller.accountId,
      });
      expect(offer.pendingEvents.map((e) => e.type)).toEqual(['catalog.offer-tag-removed.v1']);
      expect(offer.removeTag({ typeCode, actor: seller, now: T1 })).toMatchObject({
        error: { code: 'tag.not-found' },
      });
      const suspended = withActiveTag();
      suspended.settleTags({
        facts: facts(),
        decisions: answer(suspended, (q) => refused(q, 'no-valid-seller-certificate')),
        entryPath: 'offer-edit',
        actor: seller,
        hash,
        now: T1,
      });
      expect(suspended.removeTag({ typeCode, actor: seller, now: T1 })).toMatchObject({
        error: { code: 'tag.suspended' },
      });
    });

    it('removes every open tag when the Offer is deleted, asking nothing', () => {
      const offer = withActiveTag();
      expect(offer.delete({ now: T1, actor: seller }).ok).toBe(true);
      expect(offer.tags[0]).toMatchObject({ status: 'removed', lastChangeCause: 'offer-delete' });
      expect(offer.pendingEvents.map((e) => e.type)).toEqual(['catalog.offer-deleted.v1']);
    });

    it('re-adds a removed type as a new row', () => {
      const offer = withActiveTag();
      offer.removeTag({ typeCode, actor: seller, now: T1 });
      const next = Offer.restore(offer.state, offer.tags);
      expect(add(next).ok).toBe(true);
      expect(next.tags.map((t) => t.status)).toEqual(['removed', 'active']);
    });
  });
});
