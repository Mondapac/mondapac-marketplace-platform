import { randomUUID } from 'node:crypto';
import { Temporal, ok, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, IdGenerator } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { NO_COUNTS } from '../../src/modules/catalog/application/ports/tag-reevaluation-requests';
import { ClaimQueryBuilder } from '../../src/modules/catalog/application/tags/claim-query-builder';
import { markProductForReevaluation } from '../../src/modules/catalog/application/tags/publish-fan-out';
import { OwnOfferAddTag } from '../../src/modules/catalog/application/use-cases/own-offer-add-tag.use-case';
import type { CatalogMarketPolicy } from '../../src/modules/catalog/application/ports/catalog-market-policy';
import { OfferListingsQuery } from '../../src/modules/catalog/application/use-cases/offer-listings.use-case';
import { ReevaluateTags } from '../../src/modules/catalog/application/use-cases/reevaluate-tags.use-case';
import { PrismaCategoryPathsReader } from '../../src/modules/catalog/infrastructure/prisma-category-paths.reader';
import { PrismaOfferListingsReader } from '../../src/modules/catalog/infrastructure/prisma-offer-listings.reader';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaProductRevisionRepository } from '../../src/modules/catalog/infrastructure/prisma-product-revision.repository';
import { PrismaTagReevaluationRequests } from '../../src/modules/catalog/infrastructure/prisma-tag-reevaluation-requests';
import { PrismaTagSelectionReader } from '../../src/modules/catalog/infrastructure/prisma-tag-selection.reader';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import {
  FakeClaimEvaluator,
  RecordingOutbox,
  allowedDecision,
  ownedRequests,
  refusedDecision,
} from '../support/catalog-tag-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Catalog slice 11 on PostgreSQL (catalog design 5.1a point 3, 5.4, 9.1; data design 3.16, 3.18;
// migration 20261017180000_catalog_fanout), for both Market fixtures: a tag write waits on the
// product row a publish holds and then asks again against the new revision; the fan-out marks
// `rechecking` in the publish unit and the job settles each Offer once, a second run changing
// nothing; the request table's CHECKs, uniques and grants; and `offerListings` answering published
// state only, with no tag for the anonymous rule (no badge from a stored tag until slice 12).

const T0 = '2026-10-17T00:00:00Z';
const HASH = `sha256:${'a'.repeat(64)}`;
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ids: IdGenerator = { next: <K extends string>() => uuid7() as Id<K> };
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });

describe.each(TEST_MARKETS)(
  'catalog publication re-ask in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    const typeCode = code === 'AU' ? 'halal' : 'zz-cert';
    const base = { market_id: market.marketId, tenant_id: market.tenantId };
    const certificate = {
      certificateId: uuid7() as Id,
      versionId: uuid7() as Id,
      typeRevisionId: uuid7() as Id,
    };
    let owner: Client;
    let sql: Client;
    let persistence: Persistence;

    beforeAll(async () => {
      owner = new Client({ connectionString: ownerTestDatabaseUrl() });
      sql = new Client({ connectionString: testDatabaseUrl() });
      await owner.connect();
      await sql.connect();
      persistence = createPersistence();
    });
    afterAll(async () => {
      await owner.end();
      await sql.end();
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

    /** A revision of the product with its one variant and a name; answers its id. */
    async function revision(productId: string, variantId: string, no: number): Promise<string> {
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
        revision_no: no,
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
      await insert('product_revision_texts', {
        ...base,
        revision_id: id,
        locale: 'en',
        name: `Dates ${no}`,
        short_description: null,
        description: null,
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
      return id;
    }

    /** A published PLATFORM product with one published variant at revision 1. */
    async function publishedProduct() {
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
        state: 'published',
        created_at: T0,
        published_at: T0,
      });
      const first = await revision(productId, variantId, 1);
      await owner.query(
        `UPDATE catalog.products SET status = 'published', published_revision_id = $2,
              version = 2 WHERE id = $1`,
        [productId, first],
      );
      return { productId, variantId, first };
    }

    async function offerOn(productId: string, status = 'published') {
      const id = uuid7();
      const sellerId = uuid7();
      const published = status === 'published';
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
        status,
        off_sale_type_not_allowed: false,
        off_sale_product_retired: false,
        off_sale_product_not_listed: false,
        off_sale_tag_suspended: false,
        off_sale_product_paused: false,
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

    const sellerContext = (sellerId: Id<'Seller'>) =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: uuid7() as Id<'Account'>,
          sessionId: uuid7() as Id<'Session'>,
          sellerId,
        }),
      );

    const claims = () =>
      new ClaimQueryBuilder({
        products: new PrismaProductRepository(persistence.service),
        revisions: new PrismaProductRevisionRepository(persistence.service),
        categoryPaths: new PrismaCategoryPathsReader(persistence.service),
      });

    function addTagWith(evaluator: FakeClaimEvaluator) {
      return new OwnOfferAddTag(gate, {
        unitOfWork: persistence.unitOfWork,
        offers: new PrismaOfferRepository(persistence.service, ids),
        eligibility: { isEligible: () => Promise.resolve(true) },
        save: { reserveSaves: () => Promise.resolve(null) },
        claims: claims(),
        evaluator,
        outbox: new RecordingOutbox(),
        clock: new FixedClock(Temporal.Instant.from(T0)),
        ids,
      });
    }

    async function tagsOf(offerId: string) {
      const { rows } = await owner.query<{
        status: string;
        change_seq: number;
        copy_revision_id: string;
        has_badge: boolean;
      }>(
        `SELECT status, change_seq, copy_revision_id, badge_data IS NOT NULL AS has_badge
         FROM catalog.offer_tags WHERE market_id = $1 AND offer_id = $2 AND status <> 'removed'`,
        [market.marketId, offerId],
      );
      return rows;
    }

    it('makes a tag write wait for a publish holding the product row, then ask the new revision', async () => {
      const { productId, variantId, first } = await publishedProduct();
      const { offerId, sellerId } = await offerOn(productId);
      const second = await revision(productId, variantId, 2);
      const publisher = new Client({ connectionString: ownerTestDatabaseUrl() });
      await publisher.connect();
      const publish: { committed: Promise<void> | null } = { committed: null };
      let committedAt = 0;
      const evaluator = new FakeClaimEvaluator(
        (query) => allowedDecision(query, certificate),
        [typeCode],
      );
      const evaluate = evaluator.evaluate.bind(evaluator);
      evaluator.evaluate = async (context, queries) => {
        const answer = await evaluate(context, queries);
        if (publish.committed === null) {
          // A publish takes the product row after this ask and commits ~300 ms later, while the
          // add-tag unit waits on the conditional product lock.
          await publisher.query('BEGIN');
          await publisher.query(
            `UPDATE catalog.products SET published_revision_id = $2, version = version + 1
            WHERE id = $1`,
            [productId, second],
          );
          publish.committed = new Promise((resolve, reject) => {
            setTimeout(() => {
              committedAt = Date.now();
              publisher.query('COMMIT').then(() => resolve(), reject);
            }, 300);
          });
        }
        return answer;
      };
      try {
        const outcome = await addTagWith(evaluator).execute(sellerContext(sellerId), {
          offerId,
          typeCode,
        });
        const doneAt = Date.now();
        await publish.committed;
        expect(outcome).toEqual({
          ok: true,
          value: { typeCode, status: 'active', basis: 'SELLER' },
        });
        expect(doneAt).toBeGreaterThanOrEqual(committedAt);
        expect(evaluator.calls.map((call) => call[0]!.productRevisionId)).toEqual([first, second]);
        expect(await tagsOf(offerId)).toEqual([
          { status: 'active', change_seq: 1, copy_revision_id: second, has_badge: true },
        ]);
      } finally {
        await publisher.end();
      }
    });

    it('stores the type revision and validity of the copy on each history row (Mojtaba, slice 8 follow-up)', async () => {
      const { productId } = await publishedProduct();
      const { offerId, sellerId } = await offerOn(productId);
      const validUntil = Temporal.Instant.from('2027-01-01T00:00:00Z');
      const evaluator = new FakeClaimEvaluator(
        (query) =>
          allowedDecision(query, certificate, {
            certificate: {
              ...allowedDecision(query, certificate).certificate!,
              validUntil,
            },
          }),
        [typeCode],
      );
      expect(
        await addTagWith(evaluator).execute(sellerContext(sellerId), { offerId, typeCode }),
      ).toMatchObject({ ok: true });
      const { rows } = await owner.query<{ type_revision_id: string; valid_until: Date }>(
        `SELECT type_revision_id, valid_until FROM catalog.offer_tag_history
        WHERE market_id = $1 AND offer_id = $2`,
        [market.marketId, offerId],
      );
      expect(rows).toEqual([
        {
          type_revision_id: certificate.typeRevisionId,
          valid_until: new Date(validUntil.epochMilliseconds),
        },
      ]);
    });

    describe('the publish fan-out', () => {
      const now = Temporal.Instant.from('2026-10-17T02:00:00Z');
      /** The products this block published: its job settles their requests only (slice 12). */
      const ownProducts = new Set<string>();

      /** Two Offers with an active tag each, then a publish of revision 2 with its fan-out unit. */
      async function publishedWithTags() {
        const { productId, variantId } = await publishedProduct();
        const offers = [await offerOn(productId), await offerOn(productId)];
        const evaluator = new FakeClaimEvaluator(
          (query) => allowedDecision(query, certificate),
          [typeCode],
        );
        for (const { offerId, sellerId } of offers) {
          expect(
            await addTagWith(evaluator).execute(sellerContext(sellerId), { offerId, typeCode }),
          ).toMatchObject({ ok: true });
        }
        const second = await revision(productId, variantId, 2);
        const marked = await persistence.unitOfWork.run(market, async () => {
          await persistence.service.tx(market).catalogProduct.updateMany({
            where: { marketId: market.marketId, id: productId },
            data: { publishedRevisionId: second, version: { increment: 1 } },
          });
          return ok(
            await markProductForReevaluation(
              {
                offers: new PrismaOfferRepository(persistence.service, ids),
                requests: new PrismaTagReevaluationRequests(persistence.service),
                ids,
              },
              market,
              {
                productId: productId as Id<'Product'>,
                revisionId: second as Id<'ProductRevision'>,
                actor: { kind: 'admin', accountId: uuid7() as Id<'Account'> },
                now,
              },
            ),
          );
        });
        expect(marked).toEqual({ ok: true, value: 2 });
        ownProducts.add(productId);
        return { productId, second, offers };
      }

      function job(evaluator: FakeClaimEvaluator) {
        return new ReevaluateTags(gate, {
          unitOfWork: persistence.unitOfWork,
          requests: ownedRequests(
            new PrismaTagReevaluationRequests(persistence.service),
            (request) =>
              request.kind === 'revision-published' && ownProducts.has(request.productId),
          ),
          offers: new PrismaOfferRepository(persistence.service, ids),
          claims: claims(),
          evaluator,
          outbox: new RecordingOutbox(),
          clock: new FixedClock(now),
          tagSelection: new PrismaTagSelectionReader(persistence.service),
        });
      }

      async function requestOf(productId: string) {
        const { rows } = await owner.query<{ state: string; counts: Record<string, number> }>(
          `SELECT state, counts FROM catalog.tag_reevaluation_requests
          WHERE market_id = $1 AND product_id = $2 ORDER BY created_at, id`,
          [market.marketId, productId],
        );
        return rows;
      }

      async function historyCount(offerId: string): Promise<number> {
        const { rows } = await owner.query<{ n: string }>(
          `SELECT count(*) AS n FROM catalog.offer_tag_history WHERE market_id = $1 AND offer_id = $2`,
          [market.marketId, offerId],
        );
        return Number(rows[0]!.n);
      }

      it('marks every active tag rechecking in the publish unit and writes one pending request', async () => {
        const { productId, offers } = await publishedWithTags();
        for (const { offerId } of offers) {
          expect(await tagsOf(offerId)).toEqual([
            expect.objectContaining({ status: 'rechecking', change_seq: 2, has_badge: false }),
          ]);
        }
        expect(await requestOf(productId)).toEqual([expect.objectContaining({ state: 'pending' })]);
      });

      it('settles every Offer against the new revision once; a second run changes nothing', async () => {
        const { productId, second, offers } = await publishedWithTags();
        const evaluator = new FakeClaimEvaluator(
          (query) => allowedDecision(query, certificate),
          [typeCode],
        );
        const first = await job(evaluator).execute(testCallContext(market, 'system'), {});
        expect(first).toMatchObject({ ok: true, value: { open: 0 } });
        expect(first.ok && first.value.closed).toBeGreaterThanOrEqual(1);
        const asked = evaluator.calls.flat().filter((q) => q.productId === productId);
        expect(new Set(asked.map((q) => q.productRevisionId))).toEqual(new Set([second]));
        const histories: number[] = [];
        for (const { offerId } of offers) {
          expect(await tagsOf(offerId)).toEqual([
            { status: 'active', change_seq: 3, copy_revision_id: second, has_badge: true },
          ]);
          histories.push(await historyCount(offerId));
        }
        expect(await requestOf(productId)).toEqual([
          { state: 'settled', counts: expect.objectContaining({ kept: 2, asked: 2 }) as unknown },
        ]);

        const callsBefore = evaluator.calls.length;
        await job(evaluator).execute(testCallContext(market, 'system'), {});
        const again = evaluator.calls.slice(callsBefore).flat();
        expect(again.filter((q) => q.productId === productId)).toEqual([]);
        for (const [i, { offerId }] of offers.entries()) {
          expect(await tagsOf(offerId)).toEqual([
            { status: 'active', change_seq: 3, copy_revision_id: second, has_badge: true },
          ]);
          expect(await historyCount(offerId)).toBe(histories[i]);
        }
      });

      it('suspends a refused tag and leaves tags rechecking while the ask is unanswered', async () => {
        const { productId, offers } = await publishedWithTags();
        const evaluator = new FakeClaimEvaluator(
          (query) => refusedDecision(query, 'policy-not-applicable'),
          [typeCode],
        );
        evaluator.unavailable = true;
        await job(evaluator).execute(testCallContext(market, 'system'), {});
        for (const { offerId } of offers) {
          expect((await tagsOf(offerId))[0]).toMatchObject({
            status: 'rechecking',
            has_badge: false,
          });
        }
        expect(await requestOf(productId)).toEqual([expect.objectContaining({ state: 'pending' })]);

        evaluator.unavailable = false;
        await job(evaluator).execute(testCallContext(market, 'system'), {});
        for (const { offerId } of offers) {
          expect((await tagsOf(offerId))[0]).toMatchObject({
            status: 'suspended',
            has_badge: false,
          });
          const { rows } = await owner.query<{ listed: boolean; off: boolean }>(
            `SELECT listed, off_sale_tag_suspended AS off FROM catalog.offers
            WHERE market_id = $1 AND id = $2`,
            [market.marketId, offerId],
          );
          expect(rows).toEqual([{ listed: false, off: true }]);
        }
        expect(await requestOf(productId)).toEqual([expect.objectContaining({ state: 'settled' })]);
      });
    });

    describe('catalog.tag_reevaluation_requests', () => {
      const row = (
        productId: string,
        revisionId: string,
        overrides: Record<string, unknown> = {},
      ) => ({
        id: uuid7(),
        ...base,
        kind: 'revision-published',
        product_id: productId,
        product_revision_id: revisionId,
        source_event_id: null,
        state: 'pending',
        cursor_offer_id: null,
        counts: '{}',
        created_at: T0,
        settled_at: null,
        ...overrides,
      });
      const codeOf = async (work: Promise<unknown>) =>
        work.then(
          () => null,
          (error: { code?: string }) => error.code ?? 'unknown',
        );

      it('checks the columns, keeps one pending request per product and one per revision', async () => {
        const { productId, variantId, first } = await publishedProduct();
        const second = await revision(productId, variantId, 2);
        expect(await codeOf(insert('tag_reevaluation_requests', row(productId, first), sql))).toBe(
          null,
        );
        expect(await codeOf(insert('tag_reevaluation_requests', row(productId, second), sql))).toBe(
          '23505',
        );
        expect(
          await codeOf(
            insert(
              'tag_reevaluation_requests',
              row(productId, first, { state: 'settled', settled_at: T0 }),
              sql,
            ),
          ),
        ).toBe('23505');
        for (const bad of [
          { state: 'settled' },
          { state: 'pending', settled_at: T0 },
          { kind: 'other' },
          { source_event_id: uuid7() },
          { counts: '[]' },
          { product_revision_id: null },
        ]) {
          expect(
            await codeOf(insert('tag_reevaluation_requests', row(productId, second, bad), sql)),
          ).toBe('23514');
        }
        // A revision of another product is refused by the foreign key.
        const other = await publishedProduct();
        expect(
          await codeOf(
            insert(
              'tag_reevaluation_requests',
              row(productId, other.first, { state: 'superseded', settled_at: T0 }),
              sql,
            ),
          ),
        ).toBe('23503');
      });

      it('moves the cursor only forward and stores counts alone at an equal cursor (Mojtaba F4)', async () => {
        const { productId, first } = await publishedProduct();
        const repo = new PrismaTagReevaluationRequests(persistence.service);
        const id = uuid7() as Id<'TagReevaluationRequest'>;
        const progress = (cursor: string | null, unavailable: number) =>
          persistence.unitOfWork.run(market, async () =>
            ok(
              await repo.progress(market, id, {
                cursorOfferId: cursor as Id<'Offer'> | null,
                counts: { ...NO_COUNTS, unavailable },
              }),
            ),
          );
        await persistence.unitOfWork.run(market, async () => {
          await repo.requestForPublish(market, {
            id,
            productId: productId as Id<'Product'>,
            productRevisionId: first as Id<'ProductRevision'>,
            now: Temporal.Instant.from(T0),
          });
          return ok(undefined);
        });
        const stored = async () =>
          (
            await owner.query<{ cursor_offer_id: string | null; counts: { unavailable: number } }>(
              `SELECT cursor_offer_id, counts FROM catalog.tag_reevaluation_requests WHERE id = $1`,
              [id],
            )
          ).rows[0]!;
        const [low, high] = [uuid7(), uuid7()];

        expect(await progress(null, 2)).toEqual({ ok: true, value: true });
        expect(await stored()).toMatchObject({ cursor_offer_id: null, counts: { unavailable: 2 } });
        expect(await progress(high, 3)).toEqual({ ok: true, value: true });
        expect(await progress(high, 5)).toEqual({ ok: true, value: true });
        expect(await stored()).toMatchObject({ cursor_offer_id: high, counts: { unavailable: 5 } });
        expect(await progress(low, 7)).toEqual({ ok: true, value: false });
        expect(await progress(null, 7)).toEqual({ ok: true, value: false });
        expect(await stored()).toMatchObject({ cursor_offer_id: high, counts: { unavailable: 5 } });
      });

      it('grants no DELETE and no update of the identity columns', async () => {
        const { productId, first } = await publishedProduct();
        const stored = row(productId, first);
        await insert('tag_reevaluation_requests', stored, sql);
        expect(
          await codeOf(
            sql.query(`DELETE FROM catalog.tag_reevaluation_requests WHERE id = $1`, [stored.id]),
          ),
        ).toBe('42501');
        expect(
          await codeOf(
            sql.query(
              `UPDATE catalog.tag_reevaluation_requests SET product_id = $2 WHERE id = $1`,
              [stored.id, uuid7()],
            ),
          ),
        ).toBe('42501');
      });
    });

    describe('offerListings', () => {
      it('answers published state only, and no tag or badge for the anonymous rule', async () => {
        const { productId, variantId, first } = await publishedProduct();
        const { offerId: activeOffer, sellerId } = await offerOn(productId);
        const { offerId: suspendedOffer, sellerId: suspendedSeller } = await offerOn(productId);
        const { offerId: draft } = await offerOn(productId, 'draft');
        const allow = new FakeClaimEvaluator(
          (query) => allowedDecision(query, certificate),
          [typeCode],
        );
        for (const [offerId, seller] of [
          [activeOffer, sellerId],
          [suspendedOffer, suspendedSeller],
        ] as const) {
          expect(
            await addTagWith(allow).execute(sellerContext(seller), { offerId, typeCode }),
          ).toMatchObject({ ok: true });
        }
        // Suspend the second Offer's tag through the domain path (an edit re-ask refusing it).
        const offers = new PrismaOfferRepository(persistence.service, ids);
        const builder = claims();
        await persistence.unitOfWork.run(market, async () => {
          const offer = (await offers.findById(market, suspendedOffer))!;
          const facts = await builder.publishedFactsOf(market, productId as Id<'Product'>);
          const queries = builder.queries(offer.state, facts!, [typeCode])!;
          offer.settleTags({
            facts,
            decisions: new Map(
              [...queries.entries()].map(([type, qs]) => [
                type,
                qs.map((q) => refusedDecision(q, 'certificate-expired')),
              ]),
            ),
            entryPath: 'offer-edit',
            actor: { kind: 'seller', accountId: uuid7() as Id<'Account'> },
            hash: () => 'a'.repeat(64),
            now: Temporal.Instant.from('2026-10-17T03:00:00Z'),
          });
          await offers.save(market, offer, { kind: 'seller', accountId: uuid7() as Id<'Account'> });
          return ok(undefined);
        });

        const reader = new PrismaOfferListingsReader(persistence.service);
        const keys = [activeOffer, suspendedOffer, draft].map((offerId) => ({
          offerId,
          variantId: variantId as Id<'Variant'>,
        }));
        const read = (tags: 'none' | 'live') =>
          persistence.unitOfWork.run(
            market,
            async () =>
              ok(
                await reader.read(
                  market,
                  keys,
                  { requested: 'en', fallback: 'en' },
                  tags,
                  Temporal.Instant.from('2026-10-17T04:00:00Z'),
                ),
              ),
            { readOnly: true },
          );
        const anonymous = await read('none');
        const system = await read('live');
        if (!anonymous.ok || !system.ok) throw new Error('read failed');
        const key = (offerId: string) => `${offerId}:${variantId}`;

        expect(anonymous.value.has(key(draft))).toBe(false);
        expect(anonymous.value.get(key(activeOffer))).toMatchObject({
          publishedRevisionId: first,
          productName: 'Dates 1',
          variantBelongs: true,
          listed: true,
          tags: [],
        });
        expect(anonymous.value.get(key(suspendedOffer))).toMatchObject({ listed: false, tags: [] });
        // The system rule gets the badge of an active tag back from slice 12 (Hassan L-1).
        expect(system.value.get(key(activeOffer))!.tags).toEqual([
          {
            typeCode,
            status: 'active',
            basis: 'SELLER',
            badge: expect.objectContaining({ typeCode, basis: 'SELLER' }) as unknown,
          },
        ]);
        expect(system.value.get(key(suspendedOffer))!.tags).toEqual([
          { typeCode, status: 'suspended', basis: 'SELLER', badge: null },
        ]);
      });

      it.each(['certificate-revoked', 'certificate-expired'])(
        'shows no badge on the anonymous read for a stored active tag whose certificate is now %s',
        async (reason) => {
          const { productId, variantId } = await publishedProduct();
          const { offerId, sellerId } = await offerOn(productId);
          const evaluator = new FakeClaimEvaluator(
            (query) => allowedDecision(query, certificate),
            [typeCode],
          );
          expect(
            await addTagWith(evaluator).execute(sellerContext(sellerId), { offerId, typeCode }),
          ).toMatchObject({ ok: true });
          // The certificate ends and its event has not been handled yet, so the stored tag is
          // still `active`; certification would now refuse it. The anonymous read shows no tag.
          evaluator.decide = (query) => refusedDecision(query, reason);
          expect(await tagsOf(offerId)).toEqual([
            expect.objectContaining({ status: 'active', has_badge: true }),
          ]);
          const listings = new OfferListingsQuery(gate, {
            unitOfWork: persistence.unitOfWork,
            listingsReader: new PrismaOfferListingsReader(persistence.service),
            policy: { locales: () => ({ default: 'en' }) } as unknown as CatalogMarketPolicy,
            clock: new FixedClock(Temporal.Instant.from(T0)),
          });
          const answer = await listings.execute(testCallContext(market, 'anonymous'), {
            keys: [{ offerId, variantId }],
            locale: 'en',
          });
          if (!answer.ok) throw new Error('read failed');
          const listing = answer.value.get(`${offerId}:${variantId}`);
          expect(listing).toMatchObject({ listed: true, tags: [] });
          expect(JSON.stringify(listing)).not.toContain('badge');
        },
      );
    });
  },
);
