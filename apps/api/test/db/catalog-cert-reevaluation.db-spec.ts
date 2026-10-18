import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Temporal, ok, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { CertificationCause } from '../../src/modules/catalog/application/ports/tag-reevaluation-requests';
import type { CatalogMarketPolicy } from '../../src/modules/catalog/application/ports/catalog-market-policy';
import { ClaimQueryBuilder } from '../../src/modules/catalog/application/tags/claim-query-builder';
import { OfferListingsSystemQuery } from '../../src/modules/catalog/application/use-cases/offer-listings-system.use-case';
import { OwnOfferAddTag } from '../../src/modules/catalog/application/use-cases/own-offer-add-tag.use-case';
import { ReconcileTags } from '../../src/modules/catalog/application/use-cases/reconcile-tags.use-case';
import { ReevaluateFromCertification } from '../../src/modules/catalog/application/use-cases/reevaluate-from-certification.use-case';
import {
  REEVALUATE_REQUESTS_PER_RUN,
  ReevaluateTags,
} from '../../src/modules/catalog/application/use-cases/reevaluate-tags.use-case';
import type { TagClaimQuery, TagDecision } from '../../src/modules/catalog/domain/offer-tag';
import { PrismaOfferListingsReader } from '../../src/modules/catalog/infrastructure/prisma-offer-listings.reader';
import { PrismaCategoryPathsReader } from '../../src/modules/catalog/infrastructure/prisma-category-paths.reader';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaProductRevisionRepository } from '../../src/modules/catalog/infrastructure/prisma-product-revision.repository';
import { PrismaTagReevaluationRequests } from '../../src/modules/catalog/infrastructure/prisma-tag-reevaluation-requests';
import { PrismaTagSelectionReader } from '../../src/modules/catalog/infrastructure/prisma-tag-selection.reader';
import { PrismaOfferOwnerNotices } from '../../src/modules/catalog/infrastructure/prisma-offer-owner-notices';
import { ConfigOfferOwnerMailSettings } from '../../src/modules/catalog/infrastructure/offer-owner-notices';
import { SendOfferOwnerNotices } from '../../src/modules/catalog/application/use-cases/send-offer-owner-notices.use-case';
import { WarnOfferOwnersOfExpiry } from '../../src/modules/catalog/application/use-cases/warn-offer-owners-of-expiry.use-case';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import type { EventDelivery } from '../../src/platform/events/event-delivery';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import type { HandledOnce, UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import {
  FakeClaimEvaluator,
  RecordingOutbox,
  allowedDecision,
  ownedRequests,
  refusedDecision,
} from '../support/catalog-tag-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Catalog slice 12 on PostgreSQL (catalog design 5.2 point 4, 5.3, 5.5, 5.6; data design 3.15,
// 3.16, 3.18; migration 20261017200000_catalog_tag_selection), for both Market fixtures: a
// consumed certification event writes one request, and the job marks, asks and settles the tags
// whose copy names the certificate (AC 12: suspended and off sale, another seller untouched, a
// basis switch announced, a repeat changing nothing); `unavailable` never activates and leaves no
// badge (fail closed); an approval restores only on a fresh allowed answer (AC 13); the
// reconciliation repairs a lost event in both directions and skips tags on a never-published
// revision (5.1a point 5); and the history-presence trigger compares the copy's type revision and
// expiry (Mojtaba F1). The specs share one database and run in parallel, so every job here lists
// only its own requests and the reconciliation only reaches tags whose last ask is in the past
// of 2001, which only this file writes.

const T0 = '2026-10-17T00:00:00Z';
const HASH = `sha256:${'a'.repeat(64)}`;
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ids: IdGenerator = { next: <K extends string>() => uuid7() as Id<K> };
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });

describe.each(TEST_MARKETS)(
  'catalog re-evaluation from certification in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    const otherMarket = marketOf(otherMarketOf(code));
    const typeCode = code === 'AU' ? 'halal' : 'zz-cert';
    const base = { market_id: market.marketId, tenant_id: market.tenantId };
    const system = () => testCallContext(market, 'system');
    let owner: Client;
    let persistence: Persistence;
    /** The events this file consumed: its job settles their requests only. */
    const ownEvents = new Set<string>();

    beforeAll(async () => {
      owner = new Client({ connectionString: ownerTestDatabaseUrl() });
      await owner.connect();
      persistence = createPersistence();
    });
    afterAll(async () => {
      await owner.end();
      await persistence.close();
    });

    async function insert(table: string, row: Record<string, unknown>, client = owner) {
      await client.query(
        `INSERT INTO catalog.${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row)
          .map((_, i) => `$${i + 1}`)
          .join(', ')})`,
        Object.values(row),
      );
    }

    /** A revision of the product with its one variant; `published` adds its decision row. */
    async function revision(productId: string, variantId: string, published: boolean) {
      const familyId = uuid7();
      const familyRevisionId = uuid7();
      await insert('attribute_families', {
        id: familyId,
        ...base,
        code: `f-${randomUUID().slice(0, 10)}`,
        status: 'active',
        created_by_kind: 'seed',
        version: 1,
        created_at: T0,
      });
      await insert('attribute_family_revisions', {
        id: familyRevisionId,
        ...base,
        family_id: familyId,
        revision_no: 1,
        groups: '[]',
        author_kind: 'seed',
        created_at: T0,
      });
      const id = uuid7();
      await insert('product_revisions', {
        id,
        ...base,
        product_id: productId,
        revision_no: 1,
        revision_kind: 'submission',
        base_revision_id: null,
        reverted_from_revision_id: null,
        family_revision_id: familyRevisionId,
        definition_revision_ids: [],
        tax_category_code: 'standard',
        attribute_values: '{}',
        field_provenance: null,
        sensitive: false,
        sensitive_reasons: [],
        content_schema_version: 1,
        content_hash: HASH,
        author_kind: 'seller',
        author_account_id: uuid7(),
        acting_admin_account_id: null,
        submitted_at: T0,
      });
      await insert('product_revision_variants', {
        ...base,
        revision_id: id,
        variant_id: variantId,
        product_id: productId,
        position: 0,
        option_key: '',
        option_values: '{}',
        labels: '{}',
      });
      if (published) {
        await insert('product_revision_decisions', {
          ...base,
          revision_id: id,
          outcome: 'published',
          publish_kind: 'admin-authored',
          approval_required_read: null,
          superseded_cause: null,
          reason_code: null,
          reason_text: null,
          required_checks: [],
          confirmed_checks: [],
          decided_by_kind: 'admin',
          decided_by_account_id: uuid7(),
          product_version: 2,
          decided_at: T0,
        });
      }
      return id;
    }

    /** A PLATFORM product with one variant; published at revision 1 unless `published` is false. */
    async function product(published = true) {
      const productId = uuid7();
      const variantId = uuid7();
      await insert('products', {
        id: productId,
        ...base,
        scope: 'PLATFORM',
        owner_seller_id: null,
        created_by_seller_id: null,
        type_code: 'simple',
        variant_model: 'single',
        family_code: 'default',
        product_code: `R${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
        status: 'draft',
        own_brand: false,
        last_changed_at: T0,
        version: 1,
        created_at: T0,
      });
      await insert('product_variants', {
        id: variantId,
        ...base,
        product_id: productId,
        variant_model: 'single',
        state: published ? 'published' : 'proposed',
        created_at: T0,
        published_at: published ? T0 : null,
      });
      const revisionId = await revision(productId, variantId, published);
      if (published) {
        await owner.query(
          `UPDATE catalog.products SET status = 'published', published_revision_id = $2,
                version = 2 WHERE id = $1`,
          [productId, revisionId],
        );
      }
      return { productId, variantId, revisionId };
    }

    async function offerOn(productId: string, published = true) {
      const id = uuid7();
      const sellerId = uuid7();
      await insert('offers', {
        id,
        ...base,
        seller_id: sellerId,
        product_id: productId,
        seller_sku: `SKU-${randomUUID().slice(0, 13)}`,
        condition_code: 'new',
        description: '{}',
        handling: 'SEALED_ORIGINAL',
        attestation_recorded_at: null,
        attestation_account_id: null,
        status: published ? 'published' : 'draft',
        off_sale_type_not_allowed: false,
        off_sale_product_retired: false,
        off_sale_product_not_listed: false,
        off_sale_tag_suspended: false,
        off_sale_description_claim_text: false,
        listed: published,
        submitted_at: published ? T0 : null,
        first_published_at: published ? T0 : null,
        deleted_at: null,
        version: 1,
        created_at: T0,
      });
      return { offerId: id as Id<'Offer'>, sellerId: sellerId as Id<'Seller'> };
    }

    const certificateOf = () => ({
      certificateId: uuid7() as Id,
      versionId: uuid7() as Id,
      typeRevisionId: uuid7() as Id,
    });

    const claims = () =>
      new ClaimQueryBuilder({
        products: new PrismaProductRepository(persistence.service),
        revisions: new PrismaProductRevisionRepository(persistence.service),
        categoryPaths: new PrismaCategoryPathsReader(persistence.service),
      });

    /**
     * An Offer of a new seller on the product, with an active tag on its own certificate (valid
     * until `validUntil` when given, else without an expiry).
     */
    async function taggedOffer(
      productId: string,
      validUntil?: string,
      tagType = typeCode,
      manufacturer?: ReturnType<typeof certificateOf>,
    ) {
      const offer = await offerOn(productId);
      const certificate = manufacturer ?? certificateOf();
      const evaluator = new FakeClaimEvaluator(
        (query) => {
          const base = allowedDecision(query, certificate);
          // A manufacturer basis (slice 15, request C-6): the shared certificate of the product.
          const allowed: TagDecision =
            manufacturer === undefined
              ? base
              : {
                  ...base,
                  basis: 'MANUFACTURER',
                  certificate: { ...base.certificate!, kind: 'manufacturer' },
                  badge: { ...base.badge!, basis: 'MANUFACTURER', sellerClaim: false },
                };
          return validUntil === undefined
            ? allowed
            : {
                ...allowed,
                certificate: {
                  ...allowed.certificate!,
                  validUntil: Temporal.Instant.from(validUntil),
                },
                badge: {
                  ...allowed.badge!,
                  validUntilLocalDate: validUntil.slice(0, 10),
                  validUntilZone: 'UTC',
                },
              };
        },
        [tagType],
      );
      const added = await new OwnOfferAddTag(gate, {
        unitOfWork: persistence.unitOfWork,
        offers: new PrismaOfferRepository(persistence.service, ids),
        eligibility: { isEligible: () => Promise.resolve(true) },
        save: { reserveSaves: () => Promise.resolve(null) },
        claims: claims(),
        evaluator,
        outbox: new RecordingOutbox(),
        clock: new FixedClock(Temporal.Instant.from(T0)),
        ids,
      }).execute(
        testCallContext(
          market,
          testAuthenticatedActor(market, {
            population: 'seller',
            accountId: uuid7() as Id<'Account'>,
            sessionId: uuid7() as Id<'Session'>,
            sellerId: offer.sellerId,
          }),
        ),
        { offerId: offer.offerId, typeCode: tagType },
      );
      expect(added).toMatchObject({ ok: true });
      return { ...offer, certificate };
    }

    /**
     * An evaluator that answers per seller (the queries carry the seller id); a seller this test
     * does not name is answered `unavailable`, so nothing of another test can become active.
     */
    function evaluatorFor(answers: Map<string, (query: TagClaimQuery) => TagDecision>) {
      return new FakeClaimEvaluator(
        (query) => answers.get(query.sellerId)?.(query) ?? refusedDecision(query, 'unavailable'),
        [typeCode],
      );
    }

    /** `runOnce` without the inbox (the inbox is the platform's, test/db/event-delivery). */
    const withoutInbox: () => UnitOfWork = () => ({
      run: (...args) => persistence.unitOfWork.run(...args),
      runOnce: async <T, E>(
        m: Parameters<UnitOfWork['runOnce']>[0],
        _delivery: EventDelivery,
        work: () => Promise<Result<T, E>>,
        options?: Parameters<UnitOfWork['runOnce']>[3],
      ): Promise<Result<HandledOnce<T>, E>> => {
        const done = await persistence.unitOfWork.run(m, work, options);
        return done.ok ? ok({ handled: true, value: done.value }) : done;
      },
    });

    /** Consumes one certification event: the handler writes its request. */
    async function consume(
      cause: CertificationCause,
      subjectId: string,
      eventId = uuid7(),
      at = '2026-10-17T05:00:00Z',
      recheckCertificateId?: string,
      occurredAt: string = at,
    ) {
      ownEvents.add(eventId);
      const handler = new ReevaluateFromCertification(gate, {
        unitOfWork: withoutInbox(),
        requests: new PrismaTagReevaluationRequests(persistence.service),
        ids,
        clock: new FixedClock(Temporal.Instant.from(at)),
      });
      const delivery: EventDelivery = {
        eventId: eventId as Id<'event'>,
        subscriber: `catalog.reevaluate-on-${cause}`,
        attempt: 1,
      };
      expect(
        await handler.execute(system(), {
          delivery,
          occurredAt: Temporal.Instant.from(occurredAt),
          cause,
          subjectId: subjectId as Id,
          ...(recheckCertificateId === undefined
            ? {}
            : { recheckCertificateId: recheckCertificateId as Id }),
        }),
      ).toEqual({ ok: true, value: { code: 'catalog.reevaluation-requested' } });
      return eventId;
    }

    function job(evaluator: FakeClaimEvaluator, outbox = new RecordingOutbox()) {
      return new ReevaluateTags(gate, {
        unitOfWork: persistence.unitOfWork,
        requests: ownedRequests(
          new PrismaTagReevaluationRequests(persistence.service),
          (request) =>
            request.kind === 'certification-event' && ownEvents.has(request.sourceEventId),
        ),
        offers: new PrismaOfferRepository(persistence.service, ids),
        claims: claims(),
        evaluator,
        outbox,
        clock: new FixedClock(Temporal.Instant.from('2026-10-17T06:00:00Z')),
        tagSelection: new PrismaTagSelectionReader(persistence.service),
      });
    }

    async function tagOf(offerId: string) {
      const { rows } = await owner.query<{
        status: string;
        change_seq: number;
        basis: string | null;
        has_badge: boolean;
        last_reason_code: string | null;
      }>(
        `SELECT status, change_seq, basis, badge_data IS NOT NULL AS has_badge, last_reason_code
         FROM catalog.offer_tags WHERE market_id = $1 AND offer_id = $2 AND status <> 'removed'`,
        [market.marketId, offerId],
      );
      return rows[0];
    }

    async function offerRow(offerId: string) {
      const { rows } = await owner.query<{ status: string; listed: boolean; off: boolean }>(
        `SELECT status, listed, off_sale_tag_suspended AS off FROM catalog.offers
         WHERE market_id = $1 AND id = $2`,
        [market.marketId, offerId],
      );
      return rows[0];
    }

    async function historyOf(offerId: string) {
      const { rows } = await owner.query<{
        to_status: string;
        entry_path: string;
        cause_event_id: string | null;
        actor_kind: string;
      }>(
        `SELECT to_status, entry_path, cause_event_id, actor_kind FROM catalog.offer_tag_history
         WHERE market_id = $1 AND offer_id = $2 ORDER BY change_seq`,
        [market.marketId, offerId],
      );
      return rows;
    }

    async function requestOf(eventId: string) {
      const { rows } = await owner.query<{
        kind: string;
        cause: string;
        subject_id: string;
        state: string;
        counts: Record<string, number>;
      }>(
        `SELECT kind, cause, subject_id, state, counts FROM catalog.tag_reevaluation_requests
         WHERE market_id = $1 AND source_event_id = $2`,
        [market.marketId, eventId],
      );
      return rows;
    }

    const askedSellers = (evaluator: FakeClaimEvaluator) =>
      new Set(evaluator.calls.flat().map((query) => query.sellerId));

    /** The `system` offerListings read of one Offer at `now`: its tags with their badges. */
    async function systemTags(offerId: string, variantId: string, now: string) {
      const listings = new OfferListingsSystemQuery(gate, {
        unitOfWork: persistence.unitOfWork,
        listingsReader: new PrismaOfferListingsReader(persistence.service),
        policy: { locales: () => ({ default: 'en' }) } as unknown as CatalogMarketPolicy,
        clock: new FixedClock(Temporal.Instant.from(now)),
      });
      const answer = await listings.execute(system(), {
        keys: [{ offerId, variantId }],
        locale: 'en',
      });
      if (!answer.ok) throw new Error('read failed');
      return answer.value.get(`${offerId}:${variantId}`)!.tags;
    }

    describe('certification events (design 5.5)', () => {
      it('suspends the expired certificate’s tag only: off sale, not deleted; a repeat changes nothing (AC 12)', async () => {
        const { productId } = await product();
        const s = await taggedOffer(productId);
        const t = await taggedOffer(productId);
        const eventId = await consume('seller-certification-expired', s.certificate.certificateId);
        expect(await requestOf(eventId)).toEqual([
          expect.objectContaining({
            kind: 'certification-event',
            cause: 'seller-certification-expired',
            subject_id: s.certificate.certificateId,
            state: 'pending',
          }),
        ]);

        const evaluator = evaluatorFor(
          new Map([
            [s.sellerId, (q) => refusedDecision(q, 'certificate-expired')],
            [t.sellerId, (q) => allowedDecision(q, t.certificate)],
          ]),
        );
        const outbox = new RecordingOutbox();
        expect(await job(evaluator, outbox).execute(system(), {})).toMatchObject({ ok: true });

        expect(await tagOf(s.offerId)).toMatchObject({
          status: 'suspended',
          has_badge: false,
          last_reason_code: 'certificate-expired',
        });
        expect(await offerRow(s.offerId)).toEqual({
          status: 'published',
          listed: false,
          off: true,
        });
        // Seller T's Offer on the same product is neither asked nor changed.
        expect(askedSellers(evaluator)).toEqual(new Set([s.sellerId]));
        expect(await tagOf(t.offerId)).toMatchObject({ status: 'active', change_seq: 1 });
        expect(await offerRow(t.offerId)).toMatchObject({ listed: true });
        expect(await historyOf(s.offerId)).toEqual([
          expect.objectContaining({ to_status: 'active', entry_path: 'tag-add' }),
          {
            to_status: 'rechecking',
            entry_path: 'certification-event',
            cause_event_id: eventId,
            actor_kind: 'system',
          },
          {
            to_status: 'suspended',
            entry_path: 'certification-event',
            cause_event_id: eventId,
            actor_kind: 'system',
          },
        ]);
        expect(outbox.types).toEqual(
          expect.arrayContaining([
            'catalog.offer-tag-suspended.v1',
            'catalog.offer-listing-changed.v1',
          ]),
        );
        // The re-ask metric (19.2 item 5) is kept on the request.
        expect(await requestOf(eventId)).toEqual([
          expect.objectContaining({
            state: 'settled',
            counts: expect.objectContaining({ asked: 1, suspended: 1 }) as unknown,
          }),
        ]);

        // A repeat of the event writes no second request, and a second run changes nothing.
        await persistence.unitOfWork.run(market, async () => {
          await new PrismaTagReevaluationRequests(persistence.service).requestForEvent(market, {
            id: uuid7() as Id<'TagReevaluationRequest'>,
            cause: 'seller-certification-expired',
            subjectId: s.certificate.certificateId,
            sourceEventId: eventId as Id,
            now: Temporal.Instant.from('2026-10-17T07:00:00Z'),
          });
          return ok(undefined);
        });
        expect(await requestOf(eventId)).toHaveLength(1);
        const calls = evaluator.calls.length;
        await job(evaluator).execute(system(), {});
        expect(evaluator.calls).toHaveLength(calls);
        expect(await historyOf(s.offerId)).toHaveLength(3);
      });

      it('switches the basis when another basis is valid after a revocation, and announces it (AC 12)', async () => {
        const { productId } = await product();
        const s = await taggedOffer(productId);
        const eventId = await consume('seller-certification-revoked', s.certificate.certificateId);
        const manufacturerId = uuid7() as Id;
        const evaluator = evaluatorFor(
          new Map([
            [
              s.sellerId,
              (q) => {
                const allowed = allowedDecision(q, s.certificate);
                return {
                  ...allowed,
                  basis: 'MANUFACTURER',
                  certificate: {
                    ...allowed.certificate!,
                    kind: 'manufacturer',
                    certificateId: manufacturerId,
                  },
                  badge: { ...allowed.badge!, basis: 'MANUFACTURER', sellerClaim: false },
                };
              },
            ],
          ]),
        );
        const outbox = new RecordingOutbox();
        await job(evaluator, outbox).execute(system(), {});
        expect(await tagOf(s.offerId)).toMatchObject({
          status: 'active',
          basis: 'MANUFACTURER',
          has_badge: true,
        });
        expect(await offerRow(s.offerId)).toMatchObject({ listed: true, off: false });
        expect(outbox.types).toEqual(['catalog.offer-tag-basis-switched.v1']);
        expect(await requestOf(eventId)).toEqual([
          expect.objectContaining({
            state: 'settled',
            counts: expect.objectContaining({ switched: 1 }) as unknown,
          }),
        ]);
      });

      it('fails closed while certification is unavailable: rechecking without a badge, retried (5.2 point 4)', async () => {
        const { productId } = await product();
        const s = await taggedOffer(productId);
        const eventId = await consume('seller-certification-revoked', s.certificate.certificateId);
        const evaluator = evaluatorFor(
          new Map([[s.sellerId, (q) => refusedDecision(q, 'certificate-revoked')]]),
        );
        evaluator.unavailable = true;
        await job(evaluator).execute(system(), {});
        expect(await tagOf(s.offerId)).toMatchObject({ status: 'rechecking', has_badge: false });
        expect(await requestOf(eventId)).toEqual([
          expect.objectContaining({
            state: 'pending',
            counts: expect.objectContaining({ unavailable: 1 }) as unknown,
          }),
        ]);
        // An `unavailable` answer inside an allowed call is no better.
        evaluator.unavailable = false;
        evaluator.decide = (q) => refusedDecision(q, 'unavailable');
        await job(evaluator).execute(system(), {});
        expect(await tagOf(s.offerId)).toMatchObject({ status: 'rechecking', has_badge: false });

        evaluator.decide = (q) => refusedDecision(q, 'certificate-revoked');
        await job(evaluator).execute(system(), {});
        expect(await tagOf(s.offerId)).toMatchObject({ status: 'suspended', has_badge: false });
        expect(await requestOf(eventId)).toEqual([expect.objectContaining({ state: 'settled' })]);
      });

      it('restores a suspended tag on the approval event only from a fresh allowed answer (AC 13)', async () => {
        const { productId } = await product();
        const s = await taggedOffer(productId);
        await consume('seller-certification-expired', s.certificate.certificateId);
        const refuse = evaluatorFor(
          new Map([[s.sellerId, (q) => refusedDecision(q, 'certificate-expired')]]),
        );
        await job(refuse).execute(system(), {});
        expect(await tagOf(s.offerId)).toMatchObject({ status: 'suspended' });

        const renewal = certificateOf();
        const approvedEvent = await consume('seller-certification-approved', s.sellerId);
        const unanswered = evaluatorFor(new Map());
        await job(unanswered).execute(system(), {});
        // Unavailable never activates; a suspended tag stays suspended (off sale).
        expect(await tagOf(s.offerId)).toMatchObject({ status: 'suspended' });
        expect(await requestOf(approvedEvent)).toEqual([
          expect.objectContaining({ state: 'pending' }),
        ]);

        const outbox = new RecordingOutbox();
        const allow = evaluatorFor(new Map([[s.sellerId, (q) => allowedDecision(q, renewal)]]));
        await job(allow, outbox).execute(system(), {});
        expect(await tagOf(s.offerId)).toMatchObject({ status: 'active', has_badge: true });
        expect(await offerRow(s.offerId)).toMatchObject({ listed: true, off: false });
        expect(outbox.types).toEqual([
          'catalog.offer-tag-restored.v1',
          'catalog.offer-listing-changed.v1',
        ]);
        expect(await requestOf(approvedEvent)).toEqual([
          expect.objectContaining({
            state: 'settled',
            counts: expect.objectContaining({ restored: 1 }) as unknown,
          }),
        ]);
      });

      it('re-asks the tags of the confirmed submission (issuer confirmed)', async () => {
        const { productId } = await product();
        const s = await taggedOffer(productId);
        const eventId = await consume(
          'seller-certification-issuer-confirmed',
          s.certificate.versionId,
        );
        const evaluator = evaluatorFor(
          new Map([[s.sellerId, (q) => allowedDecision(q, s.certificate)]]),
        );
        await job(evaluator).execute(system(), {});
        expect(askedSellers(evaluator)).toEqual(new Set([s.sellerId]));
        expect(await tagOf(s.offerId)).toMatchObject({ status: 'active', change_seq: 1 });
        expect(await requestOf(eventId)).toEqual([
          expect.objectContaining({
            state: 'settled',
            counts: expect.objectContaining({ kept: 1 }) as unknown,
          }),
        ]);
      });
    });

    // Certification slice 14: the claim policy and manufacturer certificate events name a type
    // id; the job resolves its code through certification and re-asks every tag of that type.
    // Each case uses a type code of its own, so no tag of another case or file is selected.
    describe('type causes (claim policy, manufacturer certificate; slice 14)', () => {
      const ownType = () => `pc-${code.toLowerCase()}-${randomUUID().slice(0, 8)}`;

      it('claim-policy-changed re-asks every tag of the type, and only of that type', async () => {
        const { productId } = await product();
        const tagType = ownType();
        const s = await taggedOffer(productId, undefined, tagType);
        const t = await taggedOffer(productId);
        const typeId = uuid7();
        const eventId = await consume('claim-policy-changed', typeId);
        expect(await requestOf(eventId)).toEqual([
          expect.objectContaining({ cause: 'claim-policy-changed', subject_id: typeId }),
        ]);
        const evaluator = evaluatorFor(
          new Map([
            [s.sellerId, (q) => refusedDecision(q, 'no-valid-seller-certificate')],
            [t.sellerId, (q) => allowedDecision(q, t.certificate)],
          ]),
        );
        evaluator.typeCodes.set(typeId, tagType);
        await job(evaluator).execute(system(), {});
        expect(evaluator.calls.flat().map((q) => q.typeCode)).toEqual([tagType]);
        expect(await tagOf(s.offerId)).toMatchObject({ status: 'suspended', has_badge: false });
        expect(await tagOf(t.offerId)).toMatchObject({ status: 'active', change_seq: 1 });
        expect(await requestOf(eventId)).toEqual([
          expect.objectContaining({
            state: 'settled',
            counts: expect.objectContaining({ asked: 1, suspended: 1 }) as unknown,
          }),
        ]);
      });

      it('product-certification-approved restores a suspended tag of the type from a fresh allowed answer', async () => {
        const { productId } = await product();
        const tagType = ownType();
        const s = await taggedOffer(productId, undefined, tagType);
        await consume('seller-certification-expired', s.certificate.certificateId);
        await job(
          evaluatorFor(new Map([[s.sellerId, (q) => refusedDecision(q, 'certificate-expired')]])),
        ).execute(system(), {});
        expect(await tagOf(s.offerId)).toMatchObject({ status: 'suspended' });

        const typeId = uuid7();
        const eventId = await consume('product-certification-approved', typeId);
        const manufacturer = certificateOf();
        const allow = evaluatorFor(
          new Map([[s.sellerId, (q) => allowedDecision(q, manufacturer)]]),
        );
        // Certification unavailable for the type lookup: nothing is asked, the request waits.
        allow.typesUnavailable = true;
        await job(allow).execute(system(), {});
        expect(allow.calls).toEqual([]);
        expect(await requestOf(eventId)).toEqual([expect.objectContaining({ state: 'pending' })]);

        allow.typesUnavailable = false;
        allow.typeCodes.set(typeId, tagType);
        await job(allow).execute(system(), {});
        expect(await tagOf(s.offerId)).toMatchObject({ status: 'active', has_badge: true });
        expect(await requestOf(eventId)).toEqual([
          expect.objectContaining({
            state: 'settled',
            counts: expect.objectContaining({ restored: 1 }) as unknown,
          }),
        ]);
      });

      it("a coverage change rechecks the certificate's own tags first and writes one unstarted type request (Hassan M2)", async () => {
        const { productId } = await product();
        const tagType = ownType();
        const s = await taggedOffer(productId, undefined, tagType);
        const typeId = uuid7();
        const first = await consume(
          'product-certification-coverage-changed',
          typeId,
          uuid7(),
          '2026-10-17T05:00:00Z',
          s.certificate.certificateId,
        );
        // One event, two requests (one per cause; the unique is per event and cause).
        expect(
          (await requestOf(first)).map((r) => [r.cause, r.subject_id, r.state]).sort(),
        ).toEqual(
          [
            ['product-certification-coverage-changed', typeId, 'pending'],
            ['product-certification-coverage-recheck', s.certificate.certificateId, 'pending'],
          ].sort(),
        );
        // A second change of the type that occurred before the pending request was written
        // (delivered late, before any run): that request already reflects it, so the type
        // request is not written again; the recheck of its own certificate is.
        const other = uuid7();
        const second = await consume(
          'product-certification-coverage-changed',
          typeId,
          uuid7(),
          '2026-10-17T05:01:00Z',
          other,
          '2026-10-17T04:59:00Z',
        );
        expect((await requestOf(second)).map((r) => [r.cause, r.subject_id])).toEqual([
          ['product-certification-coverage-recheck', other],
        ]);
        // A third that occurred after it was written (Hassan N1): a run may already be asking
        // its first page from the older state, so the type request is written.
        const later = uuid7();
        const third = await consume(
          'product-certification-coverage-changed',
          typeId,
          uuid7(),
          '2026-10-17T05:02:00Z',
          later,
          '2026-10-17T05:00:30Z',
        );
        expect((await requestOf(third)).map((r) => [r.cause, r.subject_id]).sort()).toEqual(
          [
            ['product-certification-coverage-changed', typeId],
            ['product-certification-coverage-recheck', later],
          ].sort(),
        );

        // The product left the coverage: the run marks the tag `rechecking` before any ask, then
        // settles it from the answer.
        const evaluator = evaluatorFor(
          new Map([[s.sellerId, (q) => refusedDecision(q, 'no-valid-seller-certificate')]]),
        );
        evaluator.typeCodes.set(typeId, tagType);
        await job(evaluator).execute(system(), {});
        expect((await historyOf(s.offerId)).map((h) => h.to_status)).toContain('rechecking');
        expect(await tagOf(s.offerId)).toMatchObject({ status: 'suspended', has_badge: false });
        for (const eventId of [first, second, third]) {
          for (const request of await requestOf(eventId)) {
            expect(request.state).toBe('settled');
          }
        }
      });

      it.each([
        'product-certification-suspended',
        'product-certification-revoked',
        'product-certification-expired',
      ] as const)(
        "%s marks the certificate's own tags rechecking first, then settles them from a fresh answer (slice 15)",
        async (cause) => {
          const { productId } = await product();
          const s = await taggedOffer(productId);
          const bystander = await taggedOffer(productId);
          const eventId = await consume(cause, s.certificate.certificateId);
          expect((await requestOf(eventId)).map((r) => [r.cause, r.subject_id, r.state])).toEqual([
            [cause, s.certificate.certificateId, 'pending'],
          ]);
          const evaluator = evaluatorFor(
            new Map([[s.sellerId, (q) => refusedDecision(q, 'no-valid-seller-certificate')]]),
          );
          await job(evaluator).execute(system(), {});
          expect((await historyOf(s.offerId)).map((h) => h.to_status)).toEqual(
            expect.arrayContaining(['rechecking', 'suspended']),
          );
          expect(await tagOf(s.offerId)).toMatchObject({ status: 'suspended', has_badge: false });
          // A tag resting on another certificate is not selected.
          expect(await tagOf(bystander.offerId)).toMatchObject({ status: 'active' });
          expect(evaluator.calls.flat().every((q) => q.sellerId === s.sellerId)).toBe(true);
          expect(await requestOf(eventId)).toEqual([expect.objectContaining({ state: 'settled' })]);
        },
      );

      it('writes one notice per Owner in the handler unit; the job sends each with its own marker and retry (Hassan M1, Mojtaba N2)', async () => {
        const { productId } = await product();
        const shared = certificateOf();
        const first = await taggedOffer(productId, '2027-07-01T00:00:00Z', typeCode, shared);
        const second = await taggedOffer(productId, '2027-07-01T00:00:00Z', typeCode, shared);
        const notices = new PrismaOfferOwnerNotices(persistence.service);
        const at = Temporal.Instant.from('2027-06-01T00:00:00Z');
        const handler = new WarnOfferOwnersOfExpiry(gate, {
          unitOfWork: withoutInbox(),
          tagSelection: new PrismaTagSelectionReader(persistence.service),
          notices,
          ids,
          clock: new FixedClock(at),
        });
        const eventId = uuid7();
        const warn = () =>
          handler.execute(system(), {
            delivery: {
              eventId: eventId as Id<'event'>,
              subscriber: 'catalog.warn-offer-owners-of-expiry',
              attempt: 1,
            },
            productCertificationId: shared.certificateId,
            thresholdDays: 30,
          });
        expect(await warn()).toEqual({
          ok: true,
          value: {
            code: 'catalog.expiry-notice.queued',
            owners: 2,
            queued: 2,
            skipped: 0,
            capped: false,
          },
        });
        // The same event again (a redelivery past the inbox): the unique keeps one row per Owner.
        expect(await warn()).toMatchObject({ ok: true, value: { queued: 0 } });
        const rowsOf = async () =>
          (
            await owner.query<{
              seller_id: string;
              state: string;
              outcome: string | null;
              attempts: number;
            }>(
              `SELECT seller_id, state, outcome, attempts FROM catalog.offer_owner_notices
                WHERE market_id = $1 AND source_event_id = $2 ORDER BY seller_id`,
              [market.marketId, eventId],
            )
          ).rows;
        expect((await rowsOf()).map((r) => r.state)).toEqual(['pending', 'pending']);
        const elsewhere = await owner.query(
          `SELECT 1 FROM catalog.offer_owner_notices WHERE market_id = $1 AND source_event_id = $2`,
          [otherMarket.marketId, eventId],
        );
        expect(elsewhere.rowCount).toBe(0);

        const addressOf = (sellerId: string) => `${sellerId.slice(-6)}@example.test`;
        const sent: string[] = [];
        let failing: string | null = addressOf(first.sellerId);
        const clock = new FixedClock(at);
        const sender = new SendOfferOwnerNotices(gate, {
          unitOfWork: persistence.unitOfWork,
          notices,
          ownerContacts: { emailOf: (_c, sellerId) => Promise.resolve(addressOf(sellerId)) },
          mailTransport: {
            send: (message) => {
              if (message.to === failing) return Promise.reject(new Error('smtp'));
              sent.push(message.to);
              return Promise.resolve();
            },
          },
          mailSettings: new ConfigOfferOwnerMailSettings(markets),
          clock,
        });
        const run = () => sender.execute(system(), {});
        expect(await run()).toMatchObject({ ok: true, value: { sent: 1, deferred: 1 } });
        expect(sent).toEqual([addressOf(second.sellerId)]);
        const afterFirst = new Map((await rowsOf()).map((r) => [r.seller_id, r]));
        expect(afterFirst.get(first.sellerId)).toMatchObject({ state: 'pending', attempts: 1 });
        expect(afterFirst.get(second.sellerId)).toMatchObject({
          state: 'sent',
          outcome: null,
          attempts: 1,
        });
        // Not due yet; then due with the transport back: only the deferred Owner is mailed.
        expect(await run()).toMatchObject({ ok: true, value: { examined: 0 } });
        failing = null;
        clock.set(at.add({ minutes: 5 }));
        expect(await run()).toMatchObject({ ok: true, value: { sent: 1 } });
        expect(sent).toEqual([addressOf(second.sellerId), addressOf(first.sellerId)]);
        expect((await rowsOf()).map((r) => [r.state, r.attempts])).toEqual([
          ['sent', expect.any(Number)],
          ['sent', expect.any(Number)],
        ]);

        // The CHECKs and the grant: a sent row names no outcome; the API role deletes nothing.
        const app = new Client({ connectionString: testDatabaseUrl() });
        await app.connect();
        try {
          await expect(
            app.query(
              `UPDATE catalog.offer_owner_notices SET outcome = 'no-address'
                WHERE market_id = $1 AND source_event_id = $2`,
              [market.marketId, eventId],
            ),
          ).rejects.toMatchObject({ code: '23514' });
          await expect(
            app.query(`DELETE FROM catalog.offer_owner_notices WHERE market_id = $1`, [
              market.marketId,
            ]),
          ).rejects.toMatchObject({ code: '42501' });
        } finally {
          await app.end();
        }
      });

      it('lists the Owners of the Offers whose live badge rests on a manufacturer certificate (request C-6)', async () => {
        const { productId } = await product();
        const shared = certificateOf();
        const first = await taggedOffer(productId, '2027-07-01T00:00:00Z', typeCode, shared);
        const second = await taggedOffer(productId, '2027-06-20T00:00:00Z', typeCode, shared);
        // A seller-basis tag of the same id never counts: only kind `manufacturer` is selected.
        await taggedOffer(productId, '2027-07-01T00:00:00Z');
        const reader = new PrismaTagSelectionReader(persistence.service);
        const owners = await persistence.unitOfWork.run(
          market,
          async () => ok(await reader.ownersOfCertificate(market, shared.certificateId, 10)),
          { readOnly: true },
        );
        expect(owners.ok && [...owners.value]).toEqual(
          [
            {
              sellerId: first.sellerId,
              typeCode,
              offers: 1,
              validUntil: Temporal.Instant.from('2027-07-01T00:00:00Z'),
            },
            {
              sellerId: second.sellerId,
              typeCode,
              offers: 1,
              validUntil: Temporal.Instant.from('2027-06-20T00:00:00Z'),
            },
          ].sort((a, b) => a.sellerId.localeCompare(b.sellerId)),
        );
        // A suspended tag shows no badge: it is not warned. The other Market sees nothing.
        await consume('product-certification-suspended', shared.certificateId);
        await job(
          evaluatorFor(
            new Map([
              [first.sellerId, (q) => refusedDecision(q, 'no-valid-seller-certificate')],
              [second.sellerId, (q) => refusedDecision(q, 'no-valid-seller-certificate')],
            ]),
          ),
        ).execute(system(), {});
        const after = await persistence.unitOfWork.run(
          market,
          async () => ok(await reader.ownersOfCertificate(market, shared.certificateId, 10)),
          { readOnly: true },
        );
        expect(after.ok && after.value).toEqual([]);
        const elsewhere = await persistence.unitOfWork.run(
          otherMarket,
          async () => ok(await reader.ownersOfCertificate(otherMarket, shared.certificateId, 10)),
          { readOnly: true },
        );
        expect(elsewhere.ok && elsewhere.value).toEqual([]);
      });

      it('settles a coverage change of a type the Market does not have without asking', async () => {
        const eventId = await consume('product-certification-coverage-changed', uuid7());
        const evaluator = evaluatorFor(new Map());
        await job(evaluator).execute(system(), {});
        expect(evaluator.calls).toEqual([]);
        expect(await requestOf(eventId)).toEqual([expect.objectContaining({ state: 'settled' })]);
      });
    });

    describe('pre-marking of ending certificates (Hassan M-1)', () => {
      it('takes the badge of a revoked certificate away in the next run even behind older failing requests', async () => {
        const { productId, variantId } = await product();
        // Older ending requests that keep failing (certification answers `unavailable` for
        // their sellers) fill every slot of a run.
        const olderSellers: string[] = [];
        for (let i = 0; i < REEVALUATE_REQUESTS_PER_RUN; i += 1) {
          const older = await taggedOffer(productId);
          olderSellers.push(older.sellerId);
          await consume(
            'seller-certification-expired',
            older.certificate.certificateId,
            uuid7(),
            '2026-10-17T04:00:00Z',
          );
        }
        const target = await taggedOffer(productId);
        expect(await systemTags(target.offerId, variantId, '2026-10-17T05:30:00Z')).toEqual([
          expect.objectContaining({ status: 'active', badge: expect.anything() as unknown }),
        ]);
        const eventId = await consume(
          'seller-certification-revoked',
          target.certificate.certificateId,
          uuid7(),
          '2026-10-17T05:00:00Z',
        );
        // The target's own answer would keep it, so a settle of its request would be visible.
        const evaluator = evaluatorFor(
          new Map([[target.sellerId, (q) => allowedDecision(q, target.certificate)]]),
        );
        await job(evaluator).execute(system(), {});

        // Its request was not taken this run, yet its badge is gone.
        expect(askedSellers(evaluator).has(target.sellerId)).toBe(false);
        expect(await requestOf(eventId)).toEqual([expect.objectContaining({ state: 'pending' })]);
        expect(await tagOf(target.offerId)).toMatchObject({
          status: 'rechecking',
          has_badge: false,
        });
        expect(await systemTags(target.offerId, variantId, '2026-10-17T06:00:00Z')).toEqual([
          { typeCode, status: 'rechecking', basis: 'SELLER', badge: null },
        ]);
        expect((await historyOf(target.offerId)).at(-1)).toEqual({
          to_status: 'rechecking',
          entry_path: 'certification-event',
          cause_event_id: eventId,
          actor_kind: 'system',
        });
        // A second run marks nothing again (no second history row).
        await job(evaluator).execute(system(), {});
        expect(await historyOf(target.offerId)).toHaveLength(2);

        // Once certification answers, the older requests and then the target's are settled (and
        // none is left pending to hold the slots of this file's later tests).
        const answering = evaluatorFor(
          new Map([
            ...olderSellers.map(
              (seller) =>
                [seller, (q: TagClaimQuery) => refusedDecision(q, 'certificate-expired')] as const,
            ),
            [target.sellerId, (q: TagClaimQuery) => refusedDecision(q, 'certificate-revoked')],
          ]),
        );
        await job(answering).execute(system(), {});
        await job(answering).execute(system(), {});
        expect(await tagOf(target.offerId)).toMatchObject({ status: 'suspended' });
        expect(await requestOf(eventId)).toEqual([expect.objectContaining({ state: 'settled' })]);
      });
    });

    describe('the claim order (Hassan M-1, I-2)', () => {
      it('lists ending certificates first, never a kind this build does not settle', async () => {
        const repository = new PrismaTagReevaluationRequests(persistence.service);
        const reallowedEvent = uuid7();
        const approvedEvent = uuid7();
        const revokedEvent = uuid7();
        await insert('tag_reevaluation_requests', {
          id: uuid7(),
          ...base,
          kind: 'types-reallowed',
          product_id: null,
          product_revision_id: null,
          source_event_id: reallowedEvent,
          state: 'pending',
          cursor_offer_id: null,
          counts: '{}',
          created_at: '1999-01-01T00:00:00Z',
          settled_at: null,
        });
        const write = (cause: CertificationCause, eventId: string, at: string) =>
          persistence.unitOfWork.run(market, async () => {
            await repository.requestForEvent(market, {
              id: uuid7() as Id<'TagReevaluationRequest'>,
              cause,
              subjectId: uuid7() as Id,
              sourceEventId: eventId as Id,
              now: Temporal.Instant.from(at),
            });
            return ok(undefined);
          });
        try {
          await write('seller-certification-approved', approvedEvent, '1999-01-02T00:00:00Z');
          await write('seller-certification-revoked', revokedEvent, '1999-01-03T00:00:00Z');
          const mine = new Set([reallowedEvent, approvedEvent, revokedEvent]);
          const listed = await persistence.unitOfWork.run(
            market,
            async () => ok(await repository.listPending(market, 1000)),
            { readOnly: true },
          );
          if (!listed.ok) throw new Error('read failed');
          const own = listed.value.filter(
            (request) => request.kind === 'certification-event' && mine.has(request.sourceEventId),
          );
          expect(
            own.map((request) => request.kind === 'certification-event' && request.cause),
          ).toEqual(['seller-certification-revoked', 'seller-certification-approved']);
          // Every ending request comes before every other one.
          const firstOther = listed.value.findIndex(
            (request) =>
              request.kind !== 'certification-event' ||
              !['seller-certification-expired', 'seller-certification-revoked'].includes(
                request.cause,
              ),
          );
          const lastEnding = listed.value.findLastIndex(
            (request) =>
              request.kind === 'certification-event' &&
              ['seller-certification-expired', 'seller-certification-revoked'].includes(
                request.cause,
              ),
          );
          expect(firstOther === -1 || lastEnding < firstOther).toBe(true);
          const ending = await persistence.unitOfWork.run(
            market,
            async () =>
              ok(await repository.listPendingEnding(market, { afterId: null, limit: 1000 })),
            { readOnly: true },
          );
          if (!ending.ok) throw new Error('read failed');
          expect(
            ending.value.filter((request) => mine.has(request.sourceEventId)).map((r) => r.cause),
          ).toEqual(['seller-certification-revoked']);
        } finally {
          await owner.query(
            `DELETE FROM catalog.tag_reevaluation_requests
              WHERE market_id = $1 AND source_event_id = ANY($2::uuid[])`,
            [market.marketId, [reallowedEvent, approvedEvent, revokedEvent]],
          );
        }
      });
    });

    describe('system read and the copy expiry (Hassan L-3)', () => {
      it('drops the badge of a still active tag once now reaches its valid_until', async () => {
        const { productId, variantId } = await product();
        const validUntil = '2026-12-31T00:00:00Z';
        const s = await taggedOffer(productId, validUntil);
        expect(await tagOf(s.offerId)).toMatchObject({ status: 'active', has_badge: true });

        const before = await systemTags(s.offerId, variantId, '2026-12-30T23:59:59.999Z');
        expect(before).toEqual([
          expect.objectContaining({ status: 'active', badge: expect.anything() as unknown }),
        ]);
        for (const now of [validUntil, '2026-12-31T00:00:01Z']) {
          expect(await systemTags(s.offerId, variantId, now)).toEqual([
            { typeCode, status: 'active', basis: 'SELLER', badge: null },
          ]);
        }
        expect(await tagOf(s.offerId)).toMatchObject({ status: 'active' });
      });
    });

    describe('daily reconciliation (design 5.6)', () => {
      /** Moves the last ask of the Offer's tags to an instant only this file uses. */
      async function lastAskedAt(offerId: string, at: string) {
        await owner.query(
          `UPDATE catalog.offer_tags SET evaluated_at = $3 WHERE market_id = $1 AND offer_id = $2`,
          [market.marketId, offerId, at],
        );
      }

      function reconcile(evaluator: FakeClaimEvaluator, now: string) {
        return new ReconcileTags(gate, {
          unitOfWork: persistence.unitOfWork,
          offers: new PrismaOfferRepository(persistence.service, ids),
          claims: claims(),
          evaluator,
          outbox: new RecordingOutbox(),
          clock: new FixedClock(Temporal.Instant.from(now)),
          tagSelection: new PrismaTagSelectionReader(persistence.service),
        });
      }

      it('repairs a lost expiry and a lost approval in one run; a second run asks nothing (AC 12, 13)', async () => {
        const { productId } = await product();
        const lostExpiry = await taggedOffer(productId);
        const lostApproval = await taggedOffer(productId);
        // Make the second one suspended through an event first.
        await consume('seller-certification-revoked', lostApproval.certificate.certificateId);
        await job(
          evaluatorFor(
            new Map([[lostApproval.sellerId, (q) => refusedDecision(q, 'certificate-revoked')]]),
          ),
        ).execute(system(), {});
        expect(await tagOf(lostApproval.offerId)).toMatchObject({ status: 'suspended' });
        await lastAskedAt(lostExpiry.offerId, '2000-01-01T00:00:00Z');
        await lastAskedAt(lostApproval.offerId, '2000-01-01T00:00:01Z');

        const evaluator = evaluatorFor(
          new Map([
            [lostExpiry.sellerId, (q) => refusedDecision(q, 'certificate-expired')],
            [lostApproval.sellerId, (q) => allowedDecision(q, certificateOf())],
          ]),
        );
        const run = await reconcile(evaluator, '2000-01-02T00:00:05Z').execute(system(), {});
        expect(run).toMatchObject({
          ok: true,
          value: { suspended: 1, restored: 1, unavailable: 0 },
        });
        expect(askedSellers(evaluator)).toEqual(
          new Set([lostExpiry.sellerId, lostApproval.sellerId]),
        );
        expect(await tagOf(lostExpiry.offerId)).toMatchObject({ status: 'suspended' });
        expect(await offerRow(lostExpiry.offerId)).toMatchObject({ listed: false, off: true });
        expect(await tagOf(lostApproval.offerId)).toMatchObject({ status: 'active' });
        expect(await offerRow(lostApproval.offerId)).toMatchObject({ listed: true, off: false });
        expect((await historyOf(lostExpiry.offerId)).at(-1)).toEqual({
          to_status: 'suspended',
          entry_path: 'reconciliation',
          cause_event_id: null,
          actor_kind: 'system',
        });

        const calls = evaluator.calls.length;
        await reconcile(evaluator, '2000-01-02T00:00:05Z').execute(system(), {});
        expect(evaluator.calls).toHaveLength(calls);
      });

      it('fails closed while certification is unavailable: the badge goes, the tag stays due', async () => {
        const { productId } = await product();
        const s = await taggedOffer(productId);
        await lastAskedAt(s.offerId, '2000-02-01T00:00:00Z');
        const evaluator = evaluatorFor(
          new Map([[s.sellerId, (q) => allowedDecision(q, s.certificate)]]),
        );
        evaluator.unavailable = true;
        const now = '2000-02-02T00:00:05Z';
        expect(await reconcile(evaluator, now).execute(system(), {})).toMatchObject({
          ok: true,
          value: { unavailable: 1 },
        });
        expect(await tagOf(s.offerId)).toMatchObject({ status: 'rechecking', has_badge: false });
        expect(await offerRow(s.offerId)).toMatchObject({ listed: true });

        evaluator.unavailable = false;
        expect(await reconcile(evaluator, now).execute(system(), {})).toMatchObject({
          ok: true,
          value: { unavailable: 0 },
        });
        expect(await tagOf(s.offerId)).toMatchObject({ status: 'active', has_badge: true });
      });

      it('goes on past one Offer answered unavailable: that one loses its badge, the next is settled (Hassan L-2)', async () => {
        const { productId } = await product();
        const unanswered = await taggedOffer(productId);
        const expired = await taggedOffer(productId);
        await lastAskedAt(unanswered.offerId, '2000-04-01T00:00:00Z');
        await lastAskedAt(expired.offerId, '2000-04-01T00:00:01Z');
        const evaluator = evaluatorFor(
          new Map([
            [unanswered.sellerId, (q) => refusedDecision(q, 'unavailable')],
            [expired.sellerId, (q) => refusedDecision(q, 'certificate-expired')],
          ]),
        );
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        try {
          expect(
            await reconcile(evaluator, '2000-04-02T00:00:05Z').execute(system(), {}),
          ).toMatchObject({ ok: true, value: { suspended: 1, unavailable: 1 } });
          // Logged by id; the run itself is not a failed run (it did not stop).
          expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
              msg: 'catalog.reconcile-tags.offer-unavailable',
              offerId: unanswered.offerId,
            }),
          );
          expect(log).toHaveBeenCalledWith(
            expect.objectContaining({ msg: 'catalog.reconcile-tags', code: 'done' }),
          );
        } finally {
          warn.mockRestore();
          log.mockRestore();
        }
        expect(await tagOf(unanswered.offerId)).toMatchObject({
          status: 'rechecking',
          has_badge: false,
        });
        expect(await tagOf(expired.offerId)).toMatchObject({ status: 'suspended' });
      });

      it('never selects a tag whose copy names a never-published revision (5.1a point 5)', async () => {
        const { productId, revisionId } = await product(false);
        const { offerId, sellerId } = await offerOn(productId, false);
        const certificate = certificateOf();
        const tagId = uuid7();
        // A `pending-publish` tag of a first submit, as the submit unit writes it.
        const session = new Client({ connectionString: ownerTestDatabaseUrl() });
        await session.connect();
        try {
          await session.query('BEGIN');
          await insert(
            'offer_tags',
            {
              id: tagId,
              ...base,
              offer_id: offerId,
              seller_id: sellerId,
              type_code: typeCode,
              status: 'pending-publish',
              basis: 'SELLER',
              certificate_kind: 'seller',
              certificate_id: certificate.certificateId,
              certificate_version_id: certificate.versionId,
              issuer_id: null,
              type_revision_id: certificate.typeRevisionId,
              policy_revision_id: null,
              valid_until: null,
              badge_data: null,
              copy_revision_id: revisionId,
              copy_revision_published: false,
              inputs_hash: Buffer.alloc(32),
              last_reason_code: 'allowed',
              last_change_cause: 'revision-submit',
              evaluated_at: '2000-03-01T00:00:00Z',
              status_changed_at: T0,
              change_seq: 1,
              removed_at: null,
              removed_by_kind: null,
              removed_by_account_id: null,
              created_at: T0,
            },
            session,
          );
          await insert(
            'offer_tag_history',
            {
              id: uuid7(),
              ...base,
              tag_id: tagId,
              offer_id: offerId,
              type_code: typeCode,
              from_status: null,
              to_status: 'pending-publish',
              basis: 'SELLER',
              certificate_kind: 'seller',
              certificate_id: certificate.certificateId,
              certificate_version_id: certificate.versionId,
              issuer_id: null,
              policy_revision_id: null,
              copy_revision_id: revisionId,
              type_revision_id: certificate.typeRevisionId,
              valid_until: null,
              reason_code: 'allowed',
              entry_path: 'revision-submit',
              change_seq: 1,
              cause_event_id: null,
              actor_kind: 'seller',
              actor_account_id: uuid7(),
              acting_admin_account_id: null,
              occurred_at: T0,
            },
            session,
          );
          await session.query('COMMIT');
        } finally {
          await session.end();
        }
        const evaluator = evaluatorFor(
          new Map([[sellerId, (q) => refusedDecision(q, 'certificate-expired')]]),
        );
        await consume('seller-certification-expired', certificate.certificateId);
        await job(evaluator).execute(system(), {});
        await reconcile(evaluator, '2000-03-02T00:00:05Z').execute(system(), {});
        expect(askedSellers(evaluator).has(sellerId)).toBe(false);
        expect(await tagOf(offerId)).toMatchObject({ status: 'pending-publish', change_seq: 1 });
      });
    });

    describe('query plans (Mojtaba B3)', () => {
      /**
       * EXPLAIN of the statement the reader sends (captured from Prisma's query log), with its
       * parameters bound as the unnamed statement binds them. Sequential scans, bitmap scans and
       * sorts are off, so the plan shows whether the partial index serves the ordered read alone.
       */
      async function planOf(statement: string, params: unknown[]) {
        await owner.query('SET enable_seqscan = off');
        await owner.query('SET enable_bitmapscan = off');
        await owner.query('SET enable_sort = off');
        try {
          const plan = await owner.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${statement}`, params);
          return plan.rows.map((row) => row['QUERY PLAN']).join('\n');
        } finally {
          await owner.query('RESET enable_seqscan');
          await owner.query('RESET enable_bitmapscan');
          await owner.query('RESET enable_sort');
        }
      }

      it.each([
        ['every selected tag', ''],
        ['the active ones (pre-marking)', ' AND t.status = $8'],
      ])(
        'pages the certificate selection (%s) from its index in Offer id order, with no Sort',
        async (_label, active) => {
          const text = await planOf(
            `SELECT t.offer_id FROM catalog.offer_tags t
              WHERE (t.market_id = $1 AND t.certificate_id = $2 AND t.status <> $3${active}
                AND t.copy_revision_published = $4 AND t.offer_id > $5)
              GROUP BY t.offer_id ORDER BY t.offer_id ASC LIMIT $6 OFFSET $7`,
            [
              market.marketId,
              uuid7(),
              'removed',
              true,
              uuid7(),
              50,
              0,
              ...(active === '' ? [] : ['active']),
            ],
          );
          expect(text).toContain('offer_tags_market_id_certificate_id_idx');
          expect(text).not.toContain('Sort');
        },
      );

      it('pages the type selection (slice 14) from its index in Offer id order, with no Sort', async () => {
        const text = await planOf(
          `SELECT t.offer_id FROM catalog.offer_tags t
            WHERE (t.market_id = $1 AND t.type_code = $2 AND t.status <> $3
              AND t.copy_revision_published = $4 AND t.offer_id > $5)
            GROUP BY t.offer_id ORDER BY t.offer_id ASC LIMIT $6 OFFSET $7`,
          [market.marketId, typeCode, 'removed', true, uuid7(), 50, 0],
        );
        expect(text).toContain('offer_tags_market_id_type_code_offer_id_idx');
        expect(text).not.toContain('Sort');
      });

      it('reads the reconciliation order, decision join included, from the evaluated_at index', async () => {
        const text = await planOf(
          `SELECT t.id, t.offer_id, t.evaluated_at FROM catalog.offer_tags t
             LEFT JOIN catalog.product_revisions AS j0
               ON (j0.market_id, j0.id) = (t.market_id, t.copy_revision_id)
             LEFT JOIN catalog.product_revision_decisions AS j1
               ON (j1.market_id, j1.revision_id) = (j0.market_id, j0.id)
            WHERE (t.market_id = $1 AND t.status NOT IN ($2, $3) AND t.evaluated_at < $4
              AND t.evaluated_at >= $5
              AND (t.evaluated_at > $6 OR (t.evaluated_at = $7 AND t.id > $8))
              AND (j1.outcome = $9 AND (j1.market_id IS NOT NULL AND j1.revision_id IS NOT NULL)
                AND (j0.id IS NOT NULL)))
            ORDER BY t.evaluated_at ASC, t.id ASC LIMIT $10 OFFSET $11`,
          [
            market.marketId,
            'removed',
            'pending-publish',
            '2026-10-17T00:00:00Z',
            '2001-01-01T00:00:00Z',
            '2001-01-01T00:00:00Z',
            '2001-01-01T00:00:00Z',
            uuid7(),
            'published',
            100,
            0,
          ],
        );
        expect(text).toContain('offer_tags_market_id_evaluated_at_idx');
        expect(text).not.toContain('Sort');
        expect(text).not.toContain('SubPlan');
      });
    });

    describe('history presence compares the type revision and expiry (Mojtaba F1)', () => {
      /** A suspended tag row and, optionally, its history row, in one transaction. */
      async function writeTag(history: { typeRevision: string | null; validUntil: string | null }) {
        const { productId, revisionId } = await product();
        const { offerId, sellerId } = await offerOn(productId);
        const tagId = uuid7();
        const typeRevisionId = uuid7();
        const session = new Client({ connectionString: testDatabaseUrl() });
        await session.connect();
        try {
          await session.query('BEGIN');
          await insert(
            'offer_tags',
            {
              id: tagId,
              ...base,
              offer_id: offerId,
              seller_id: sellerId,
              type_code: typeCode,
              status: 'suspended',
              basis: 'SELLER',
              certificate_kind: 'seller',
              certificate_id: uuid7(),
              certificate_version_id: uuid7(),
              issuer_id: null,
              type_revision_id: typeRevisionId,
              policy_revision_id: null,
              valid_until: '2027-01-01T00:00:00Z',
              badge_data: null,
              copy_revision_id: revisionId,
              copy_revision_published: true,
              inputs_hash: Buffer.alloc(32),
              last_reason_code: 'certificate-expired',
              last_change_cause: 'tag-add',
              evaluated_at: T0,
              status_changed_at: T0,
              change_seq: 1,
              removed_at: null,
              removed_by_kind: null,
              removed_by_account_id: null,
              created_at: T0,
            },
            session,
          );
          const { rows } = await session.query<{
            certificate_id: string;
            certificate_version_id: string;
          }>(
            `SELECT certificate_id, certificate_version_id FROM catalog.offer_tags WHERE id = $1`,
            [tagId],
          );
          await insert(
            'offer_tag_history',
            {
              id: uuid7(),
              ...base,
              tag_id: tagId,
              offer_id: offerId,
              type_code: typeCode,
              from_status: null,
              to_status: 'suspended',
              basis: 'SELLER',
              certificate_kind: 'seller',
              certificate_id: rows[0]!.certificate_id,
              certificate_version_id: rows[0]!.certificate_version_id,
              issuer_id: null,
              policy_revision_id: null,
              copy_revision_id: revisionId,
              type_revision_id:
                history.typeRevision === 'same' ? typeRevisionId : history.typeRevision,
              valid_until: history.validUntil,
              reason_code: 'certificate-expired',
              entry_path: 'tag-add',
              change_seq: 1,
              cause_event_id: null,
              actor_kind: 'system',
              actor_account_id: null,
              acting_admin_account_id: null,
              occurred_at: T0,
            },
            session,
          );
          await session.query('COMMIT');
          return null;
        } catch (error) {
          await session.query('ROLLBACK').catch(() => undefined);
          return (error as { code?: string }).code ?? 'unknown';
        } finally {
          await session.end();
        }
      }

      it('accepts a history row equal to the copy, and refuses another type revision or expiry', async () => {
        expect(await writeTag({ typeRevision: 'same', validUntil: '2027-01-01T00:00:00Z' })).toBe(
          null,
        );
        expect(await writeTag({ typeRevision: uuid7(), validUntil: '2027-01-01T00:00:00Z' })).toBe(
          '23001',
        );
        expect(await writeTag({ typeRevision: 'same', validUntil: '2028-01-01T00:00:00Z' })).toBe(
          '23001',
        );
      });

      it('refuses a new history row with a copy but no type revision (NOT VALID CHECK)', async () => {
        expect(await writeTag({ typeRevision: null, validUntil: null })).toBe('23514');
      });
    });
  },
);
