import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import type { CheckClaimText } from '../../src/modules/catalog/application/claim-text/check-claim-text.service';
import { ClaimQueryBuilder } from '../../src/modules/catalog/application/tags/claim-query-builder';
import { AdminOfferChangeApprove } from '../../src/modules/catalog/application/use-cases/admin-offer-change-approve.use-case';
import { AdminOfferChangeReject } from '../../src/modules/catalog/application/use-cases/admin-offer-change-reject.use-case';
import { AdminOfferChangesList } from '../../src/modules/catalog/application/use-cases/admin-offer-changes-list.use-case';
import { OwnOfferDelete } from '../../src/modules/catalog/application/use-cases/own-offer-delete.use-case';
import { OwnOfferSetHandling } from '../../src/modules/catalog/application/use-cases/own-offer-set-handling.use-case';
import { OwnOfferWithdrawChange } from '../../src/modules/catalog/application/use-cases/own-offer-withdraw-change.use-case';
import { Offer } from '../../src/modules/catalog/domain/offer';
import { OfferPendingChange } from '../../src/modules/catalog/domain/offer-pending-change';
import type { OfferReviewReason } from '../../src/modules/catalog/domain/offer-review-policy';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaCategoryPathsReader } from '../../src/modules/catalog/infrastructure/prisma-category-paths.reader';
import { PrismaOfferPendingChangeRepository } from '../../src/modules/catalog/infrastructure/prisma-offer-pending-change.repository';
import {
  PrismaOfferReviewQueueFacts,
  PrismaOfferReviewReferralStore,
} from '../../src/modules/catalog/infrastructure/prisma-offer-review-referral.store';
import type { OfferChangeQueueFilter } from '../../src/modules/catalog/application/ports/offer-pending-change.repository';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaOwnCatalogReader } from '../../src/modules/catalog/infrastructure/prisma-own-catalog.reader';
import { ConfigCatalogMarketPolicy } from '../../src/modules/catalog/infrastructure/config-catalog-market-policy';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaProductRevisionRepository } from '../../src/modules/catalog/infrastructure/prisma-product-revision.repository';
import { prismaOfferEditReview } from '../support/catalog-offer-edit-review-fakes';
import {
  FakeClaimEvaluator,
  FixedFactsClaimQueryBuilder,
  RecordingOutbox,
  refusedDecision,
} from '../support/catalog-tag-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// Held edits of live Offers (risk-based Offer approval, slice 2c): the table
// catalog.offer_pending_changes and its repository on PostgreSQL, for both Market fixtures. A change
// is born pending, at most one is open per Offer (partial unique), it is decided once by a
// conditional update, never deleted (guard trigger), and the app role may move only the decision
// columns. The seller's held handling, the withdrawal and the approval run end to end.

const T0 = Temporal.Instant.from('2026-11-25T00:00:00Z');
/** The trigger checks decided_at against the statement time (5 minutes tolerance). */
const nowInstant = (): Temporal.Instant => Temporal.Instant.fromEpochMilliseconds(Date.now());
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ids = { next: <K extends string>() => uuid7() as Id<K> };
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);

describe.each(TEST_MARKETS)(
  'catalog Offer pending changes in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    let persistence: Persistence;
    let owner: Client;
    let products: PrismaProductRepository;
    let offers: PrismaOfferRepository;
    let changes: PrismaOfferPendingChangeRepository;
    const sellerId = uuid7() as Id<'Seller'>;
    const sellerAccount = uuid7() as Id<'Account'>;
    const seller = { kind: 'seller' as const, accountId: sellerAccount };

    beforeAll(async () => {
      persistence = createPersistence();
      owner = new Client({ connectionString: ownerTestDatabaseUrl() });
      await owner.connect();
      products = new PrismaProductRepository(persistence.service);
      offers = new PrismaOfferRepository(persistence.service, ids);
      changes = new PrismaOfferPendingChangeRepository(persistence.service);
    });
    afterAll(async () => {
      await owner.end();
      await persistence.close();
    });

    /** The name of the constraint a failed unit violated, or null when it did not fail. */
    const constraintOf = async (outcome: Promise<unknown>): Promise<string | null> => {
      try {
        await outcome;
        return null;
      } catch (error) {
        return persistence.service.violatedConstraint(error) ?? 'not-a-constraint';
      }
    };

    /** The admin list over the database, with fakes for the other modules (slice 5). */
    const listOf = () =>
      new AdminOfferChangesList(gate, {
        unitOfWork: persistence.unitOfWork,
        pendingChanges: changes,
        offers,
        ownReader: new PrismaOwnCatalogReader(persistence.service),
        policy: new ConfigCatalogMarketPolicy(markets),
        sellerNames: { storeNames: () => Promise.resolve(new Map()) },
        storeSearch: { sellersMatching: () => Promise.resolve({ sellerIds: [], capped: false }) },
        productApproveProbe: { execute: () => Promise.resolve({ ok: true }) },
      });

    const unit = <T>(work: () => Promise<T>) =>
      persistence.unitOfWork.run(market, async () => ({ ok: true as const, value: await work() }));

    /**
     * A published Offer with handling SEALED_ORIGINAL on a PLATFORM product; with `waiting`, one
     * submitted for review instead (pending-first-publish).
     */
    async function liveOffer(waiting = false): Promise<Id<'Offer'>> {
      const product = Product.create({
        id: uuid7() as Id<'Product'>,
        marketId: market.marketId,
        scope: 'PLATFORM',
        sellerId: null,
        handler: simpleProductType,
        familyCode: 'default',
        productCode: `P${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
        variantId: uuid7() as Id<'Variant'>,
        now: T0,
      });
      if (!product.ok) throw new Error(product.error.code);
      const created = Offer.create({
        id: uuid7() as Id<'Offer'>,
        marketId: market.marketId,
        sellerId,
        productId: product.value.state.id,
        sellerSku: `S-${uuid7().slice(-12)}`,
        conditionCode: 'new',
        description: { 'en-AU': 'Fresh dates' },
        now: T0,
      });
      if (!created.ok) throw new Error(created.error.code);
      const offerId = created.value.state.id;
      await unit(async () => {
        await products.add(market, product.value);
        await offers.add(market, created.value, seller);
      });
      await unit(async () => {
        const offer = (await offers.findById(market, offerId))!;
        offer.setHandling({ handling: 'SEALED_ORIGINAL', now: T0 });
        await offers.save(market, offer, seller);
      });
      await unit(async () => {
        const offer = (await offers.findById(market, offerId))!;
        offer.submit({ approvalRequired: waiting, now: T0 });
        await offers.save(market, offer, seller);
      });
      return offerId;
    }

    const propose = (
      offerId: Id<'Offer'>,
      overrides: { at?: Temporal.Instant; reasons?: readonly OfferReviewReason[] } = {},
    ) => {
      const made = OfferPendingChange.propose({
        id: uuid7() as Id<'OfferPendingChange'>,
        marketId: market.marketId,
        offerId,
        sellerId,
        baseOfferVersion: 3,
        proposedDescription: { 'en-AU': 'Call 0412 345 678' },
        proposedTagTypes: ['halal'],
        reasons: overrides.reasons ?? ['certificate-badge', 'contact-text'],
        policyVersion: 2,
        submittedByAccountId: sellerAccount,
        now: overrides.at ?? T0,
      });
      if (!made.ok) throw new Error(made.error.code);
      return made.value;
    };

    it('stores a pending change and reads it back by id, by Offer and in the queue', async () => {
      const offerId = await liveOffer();
      const change = propose(offerId);
      await unit(() => changes.insert(market, change));
      const read = await unit(async () => ({
        byId: await changes.findById(market, change.state.id),
        open: await changes.findOpenByOffer(market, offerId),
        latest: await changes.findLatestByOffer(market, offerId),
        queue: await changes.listPending(market, { after: null, limit: 500 }),
      }));
      if (!read.ok) throw new Error('read failed');
      expect(read.value.byId?.state).toEqual(change.state);
      expect(read.value.open?.state.id).toBe(change.state.id);
      expect(read.value.latest?.state.id).toBe(change.state.id);
      expect(read.value.queue.map((c) => c.state.id)).toContain(change.state.id);
      const row = await owner.query(
        `SELECT tenant_id, proposed_tag_types, reasons, proposed_handling, status
         FROM catalog.offer_pending_changes WHERE id = $1`,
        [change.state.id],
      );
      expect(row.rows).toEqual([
        {
          tenant_id: market.tenantId,
          proposed_tag_types: ['halal'],
          reasons: ['certificate-badge', 'contact-text'],
          proposed_handling: null,
          status: 'pending',
        },
      ]);
    });

    it('stores a change held by the emergency stop with every edit reason (R0 on edits)', async () => {
      const offerId = await liveOffer();
      const reasons = [
        'emergency-stop',
        'certificate-badge',
        'handling',
        'contact-text',
        'review-all',
      ] as const;
      const change = propose(offerId, { reasons });
      await unit(() => changes.insert(market, change));
      const row = await owner.query<{ reasons: string[] }>(
        'SELECT reasons FROM catalog.offer_pending_changes WHERE id = $1',
        [change.state.id],
      );
      expect(row.rows[0]?.reasons).toEqual([...reasons]);
    });

    it('keeps one open change per Offer (partial unique), answered as a lost race', async () => {
      const offerId = await liveOffer();
      await unit(() => changes.insert(market, propose(offerId)));
      await expect(unit(() => changes.insert(market, propose(offerId)))).rejects.toBeInstanceOf(
        StaleAggregateError,
      );
    });

    it('decides a change once: a second decision moves no row', async () => {
      const offerId = await liveOffer();
      const change = propose(offerId);
      await unit(() => changes.insert(market, change));
      const first = OfferPendingChange.restore(change.state);
      first.reject({
        accountId: uuid7() as Id<'Account'>,
        note: 'No contact details',
        now: nowInstant(),
      });
      const second = OfferPendingChange.restore(change.state);
      second.withdraw({ accountId: sellerAccount, now: nowInstant() });
      const outcome = await unit(async () => [
        await changes.decide(market, first),
        await changes.decide(market, second),
      ]);
      expect(outcome).toEqual({ ok: true, value: [true, false] });
      const row = await owner.query(
        `SELECT status, decision_note FROM catalog.offer_pending_changes WHERE id = $1`,
        [change.state.id],
      );
      expect(row.rows).toEqual([{ status: 'rejected', decision_note: 'No contact details' }]);
      // After a decision a new change may open.
      await unit(() => changes.insert(market, propose(offerId)));
    });

    it('refuses a delete, a second decision and a changed proposal, even for the owner', async () => {
      const offerId = await liveOffer();
      const change = propose(offerId);
      await unit(() => changes.insert(market, change));
      await expect(
        owner.query(`DELETE FROM catalog.offer_pending_changes WHERE id = $1`, [change.state.id]),
      ).rejects.toThrow('DELETE is not allowed');
      await expect(
        owner.query(
          `UPDATE catalog.offer_pending_changes SET reasons = '{review-all}' WHERE id = $1`,
          [change.state.id],
        ),
      ).rejects.toThrow('immutable column');
      await owner.query(
        `UPDATE catalog.offer_pending_changes
          SET status = 'withdrawn', decided_at = now(), decided_by_account_id = $2 WHERE id = $1`,
        [change.state.id, sellerAccount],
      );
      await expect(
        owner.query(
          `UPDATE catalog.offer_pending_changes SET status = 'rejected', decision_note = 'x'
          WHERE id = $1`,
          [change.state.id],
        ),
      ).rejects.toThrow('decided, once');
      await expect(
        owner.query(
          `INSERT INTO catalog.offer_pending_changes (id, market_id, tenant_id, offer_id, seller_id,
           base_offer_version, proposed_handling, reasons, policy_version, status, submitted_at,
           submitted_by_account_id, decided_at, decided_by_account_id)
         VALUES ($1, $2, $3, $4, $5, 1, 'FRESH', '{handling}', 2, 'approved', now(), $6, now(), $6)`,
          [uuid7(), code, market.tenantId, offerId, sellerId, sellerAccount],
        ),
      ).rejects.toThrow('a new change is pending');
    });

    it('grants the app role insert, select and the decision columns only', async () => {
      const table = 'catalog.offer_pending_changes';
      const rows = await owner.query(
        `SELECT has_table_privilege('mondapac_app', $1, 'DELETE') AS delete,
              has_table_privilege('mondapac_app', $1, 'TRUNCATE') AS truncate,
              has_column_privilege('mondapac_app', $1, 'status', 'UPDATE') AS status,
              has_column_privilege('mondapac_app', $1, 'decision_note', 'UPDATE') AS note,
              has_column_privilege('mondapac_app', $1, 'proposed_description', 'UPDATE') AS proposed,
              has_column_privilege('mondapac_app', $1, 'reasons', 'UPDATE') AS reasons`,
        [table],
      );
      expect(rows.rows).toEqual([
        {
          delete: false,
          truncate: false,
          status: true,
          note: true,
          proposed: false,
          reasons: false,
        },
      ]);
    });

    it('links an edit referral to its change; a first-publication referral may not name one', async () => {
      const offerId = await liveOffer();
      const change = propose(offerId);
      await unit(() => changes.insert(market, change));
      const store = new PrismaOfferReviewReferralStore(persistence.service, ids);
      const referral = {
        offerId,
        sellerId,
        offerVersion: 4,
        reasons: ['contact-text'] as const,
        policyVersion: 2,
        decidedAt: T0,
        pendingChangeId: change.state.id,
      };
      await unit(() => store.record(market, { ...referral, trigger: 'edit' }));
      expect(
        await constraintOf(
          unit(() =>
            store.record(market, { ...referral, offerVersion: 5, trigger: 'first-publication' }),
          ),
        ),
      ).toBe('offer_review_referrals_pending_change_check');
      // One referral per held change (partial unique on market and change).
      expect(
        await constraintOf(
          unit(() => store.record(market, { ...referral, offerVersion: 6, trigger: 'edit' })),
        ),
      ).toBe('offer_review_referrals_pending_change_id_key');
      // A referral with no change is not caught by that index.
      await unit(() =>
        store.record(market, {
          ...referral,
          offerVersion: 7,
          trigger: 'edit',
          pendingChangeId: null,
        }),
      );
    });

    it('pages the queue by (submitted_at, id) with no row repeated or skipped (F2)', async () => {
      // Five open changes that share one submit instant, unique to this run.
      const at = Temporal.Instant.fromEpochMilliseconds(
        Date.UTC(2001, 0, 1) + Math.floor(Math.random() * 86_400_000),
      );
      const mine: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const change = propose(await liveOffer(), { at });
        await unit(() => changes.insert(market, change));
        mine.push(change.state.id);
      }
      // Start just before the instant (the queue holds other specs' rows too).
      let after: { submittedAt: Temporal.Instant; id: string } | null = {
        submittedAt: at.subtract({ microseconds: 1 }),
        id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      };
      const seen: string[] = [];
      for (let pageNo = 0; pageNo < 10 && after !== null; pageNo += 1) {
        const page = await unit(() => changes.listPending(market, { after, limit: 2 }));
        if (!page.ok) throw new Error('page failed');
        const rows = page.value;
        seen.push(
          ...rows
            .filter((row) => row.state.submittedAt.equals(at))
            .map((row) => row.state.id as string),
        );
        const last = rows[rows.length - 1];
        after =
          rows.length < 2 || last === undefined || !last.state.submittedAt.equals(at)
            ? null
            : { submittedAt: last.state.submittedAt, id: last.state.id };
      }
      expect(seen).toEqual([...mine].sort());
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('never reads or decides a change from the other Market (repository, F2)', async () => {
      const offerId = await liveOffer();
      const change = propose(offerId);
      await unit(() => changes.insert(market, change));
      const other = marketOf(otherMarketOf(code));
      const read = await persistence.unitOfWork.run(other, async () => ({
        ok: true as const,
        value: {
          byId: await changes.findById(other, change.state.id),
          open: await changes.findOpenByOffer(other, offerId),
          latest: await changes.findLatestByOffer(other, offerId),
          queue: await changes.listPending(other, { after: null, limit: 500 }),
        },
      }));
      if (!read.ok) throw new Error('read failed');
      expect(read.value.byId).toBeNull();
      expect(read.value.open).toBeNull();
      expect(read.value.latest).toBeNull();
      expect(read.value.queue.map((c) => c.state.id)).not.toContain(change.state.id);
      const decided = OfferPendingChange.restore(change.state);
      decided.reject({ accountId: uuid7() as Id<'Account'>, note: 'Canary', now: nowInstant() });
      const moved = await persistence.unitOfWork.run(other, async () => ({
        ok: true as const,
        value: await changes.decide(other, decided),
      }));
      expect(moved).toEqual({ ok: true, value: false });
      const row = await owner.query(
        `SELECT status, decided_at, decision_note FROM catalog.offer_pending_changes WHERE id = $1`,
        [change.state.id],
      );
      expect(row.rows).toEqual([{ status: 'pending', decided_at: null, decision_note: null }]);
    });

    describe('the admin Edits list and the queue facts (slice 5)', () => {
      const locale = new ConfigCatalogMarketPolicy(markets).locales(market).default;
      const admin = (): CallContext =>
        testCallContext(
          market,
          testAuthenticatedActor(market, {
            population: 'admin',
            accountId: uuid7() as Id<'Account'>,
            sessionId: uuid7() as Id<'Session'>,
            sellerId: null,
          }),
        );

      async function category(): Promise<Id<'Category'>> {
        const id = uuid7();
        await owner.query(
          `INSERT INTO catalog.platform_categories
             (id, market_id, tenant_id, slug, status, created_by_kind, version, created_at)
           VALUES ($1, $2, $3, $4, 'active', 'seed', 1, now())`,
          [id, market.marketId, market.tenantId, `oc-${id.slice(-12)}`],
        );
        return id as Id<'Category'>;
      }

      /** Publishes a revision of the Offer's product with a name and (optionally) a category. */
      async function publish(offerId: Id<'Offer'>, name: string, categoryId?: Id<'Category'>) {
        const { rows } = await owner.query<{ product_id: string }>(
          `SELECT product_id FROM catalog.offers WHERE id = $1`,
          [offerId],
        );
        const productId = rows[0]!.product_id;
        const base = [market.marketId, market.tenantId];
        const [familyId, familyRevisionId, revisionId] = [uuid7(), uuid7(), uuid7()];
        await owner.query(
          `INSERT INTO catalog.attribute_families
             (id, market_id, tenant_id, code, status, created_by_kind, version, created_at)
           VALUES ($1, $2, $3, $4, 'active', 'seed', 1, now())`,
          [familyId, ...base, `f-${uuid7().slice(-10)}`],
        );
        await owner.query(
          `INSERT INTO catalog.attribute_family_revisions
             (id, market_id, tenant_id, family_id, revision_no, groups, author_kind, created_at)
           VALUES ($1, $2, $3, $4, 1, '[]', 'seed', now())`,
          [familyRevisionId, ...base, familyId],
        );
        await owner.query(
          `INSERT INTO catalog.product_revisions
             (id, market_id, tenant_id, product_id, revision_no, revision_kind, type_code,
              base_revision_id, reverted_from_revision_id, family_revision_id,
              definition_revision_ids, tax_category_code, attribute_values, field_provenance,
              sensitive, sensitive_reasons, content_schema_version, content_hash, author_kind,
              author_account_id, acting_admin_account_id, submitted_at)
           VALUES ($1, $2, $3, $4, 1, 'submission', 'simple', NULL, NULL, $5, '{}', 'standard',
              '{}', NULL, false, '{}', 1, $6, 'admin', $7, NULL, now())`,
          [revisionId, ...base, productId, familyRevisionId, `sha256:${'a'.repeat(64)}`, uuid7()],
        );
        await owner.query(
          `INSERT INTO catalog.product_revision_texts
             (market_id, tenant_id, revision_id, locale, name, short_description, description)
           VALUES ($1, $2, $3, $4, $5, NULL, NULL)`,
          [...base, revisionId, locale, name],
        );
        if (categoryId !== undefined) {
          await owner.query(
            `INSERT INTO catalog.product_revision_categories
               (market_id, tenant_id, revision_id, category_id, position)
             VALUES ($1, $2, $3, $4, 0)`,
            [...base, revisionId, categoryId],
          );
        }
        await owner.query(
          `UPDATE catalog.products SET status = 'published', published_revision_id = $3
            WHERE market_id = $1 AND id = $2`,
          [market.marketId, productId, revisionId],
        );
      }

      it('filters, counts and searches the pending changes in SQL, with % and _ as typed', async () => {
        const marker = uuid7().slice(-8);
        const categoryId = await category();
        // Unique instants, so other specs' rows never fall in the window.
        const at = Temporal.Instant.fromEpochMilliseconds(
          Date.UTC(2002, 0, 1) + Math.floor(Math.random() * 86_400_000),
        );
        const [a, b, c] = [await liveOffer(), await liveOffer(), await liveOffer()];
        await publish(a, `Saffron ${marker}`, categoryId);
        await publish(b, `Rice_${marker}`);
        const changeA = propose(a, { at, reasons: ['contact-text'] });
        const changeB = propose(b, { at: at.add({ minutes: 1 }), reasons: ['handling'] });
        const changeC = propose(c, {
          at: at.add({ minutes: 2 }),
          reasons: ['emergency-stop', 'certificate-badge'],
        });
        for (const change of [changeA, changeB, changeC]) {
          await unit(() => changes.insert(market, change));
        }
        const window = { submittedFrom: at, submittedTo: at.add({ minutes: 3 }) };
        const search = (text: string) => ({ text, locale, sellerIds: [] });
        const read = await unit(async () => {
          const ids = async (filter: OfferChangeQueueFilter, direction?: 'asc' | 'desc') =>
            (
              await changes.listPending(
                market,
                { after: null, limit: 50, ...(direction === undefined ? {} : { direction }) },
                { ...window, ...filter },
              )
            ).map((row) => row.state.id as string);
          return {
            all: await ids({}),
            desc: await ids({}, 'desc'),
            offset: (
              await changes.listPending(market, { after: null, limit: 1, offset: 1 }, window)
            ).map((row) => row.state.id as string),
            count: await changes.countPending(market, window),
            reasons: await ids({ reasons: ['handling', 'emergency-stop'] }),
            seller: await ids({ sellerId: uuid7() as Id<'Seller'> }),
            category: await ids({ categoryId }),
            categoryCount: await changes.countPending(market, { ...window, categoryId }),
            byName: await ids({ search: search(`saffron ${marker}`) }),
            byStore: await ids({
              search: { text: 'no-such-name', locale, sellerIds: [sellerId] },
            }),
            underscore: await ids({ search: search(`rice_${marker}`) }),
            // `_` is a literal: "riceX" never matches "Rice_".
            wildcard: await ids({ search: search(`rice%${marker}`) }),
          };
        });
        if (!read.ok) throw new Error('read failed');
        const [idA, idB, idC] = [changeA, changeB, changeC].map((x) => x.state.id as string);
        expect(read.value.all).toEqual([idA, idB, idC]);
        expect(read.value.desc).toEqual([idC, idB, idA]);
        expect(read.value.offset).toEqual([idB]);
        expect(read.value.count).toBe(3);
        expect(read.value.reasons).toEqual([idB, idC]);
        expect(read.value.seller).toEqual([]);
        expect(read.value.category).toEqual([idA]);
        expect(read.value.categoryCount).toBe(1);
        expect(read.value.byName).toEqual([idA]);
        expect(read.value.byStore).toEqual([idA, idB, idC]);
        expect(read.value.underscore).toEqual([idB]);
        expect(read.value.wildcard).toEqual([]);
      });

      it('filters waiting Offers by latest reasons, category and ids; offers the queue sellers', async () => {
        const categoryId = await category();
        const [a, b] = [await liveOffer(true), await liveOffer(true)];
        await publish(a, `Sumac ${uuid7().slice(-8)}`, categoryId);
        const store = new PrismaOfferReviewReferralStore(persistence.service, ids);
        const facts = new PrismaOfferReviewQueueFacts(persistence.service);
        const reader = new PrismaOwnCatalogReader(persistence.service);
        const referral = {
          sellerId,
          trigger: 'first-publication' as const,
          policyVersion: 4,
          decidedAt: T0,
        };
        // a was held for handling first, then for probation: only the latest decision counts.
        await unit(() =>
          store.record(market, { ...referral, offerId: a, offerVersion: 2, reasons: ['handling'] }),
        );
        await unit(() =>
          store.record(market, {
            ...referral,
            offerId: a,
            offerVersion: 3,
            reasons: ['probation'],
          }),
        );
        await unit(() =>
          store.record(market, { ...referral, offerId: b, offerVersion: 3, reasons: ['handling'] }),
        );
        const live = await liveOffer();
        await unit(() => changes.insert(market, propose(live)));
        const page = { after: null, limit: 500 };
        const read = await unit(async () => ({
          handling: await facts.pendingFirstPublicationsWithReasons(market, ['handling']),
          probation: await facts.pendingFirstPublicationsWithReasons(market, ['probation']),
          none: await facts.pendingFirstPublicationsWithReasons(market, []),
          inCategory: (
            await offers.listPendingReview(market, page, { offerIds: [a, b], categoryId })
          ).map((offer) => offer.state.id as string),
          countInCategory: await reader.pendingReviewCount(market, {
            offerIds: [a, b],
            categoryId,
          }),
          byIds: (await offers.listPendingReview(market, page, { offerIds: [b] })).map(
            (offer) => offer.state.id as string,
          ),
          noIds: await reader.pendingReviewCount(market, { offerIds: [] }),
          offerSellers: await reader.pendingQueueSellerIds(
            market,
            { offers: true, revisions: false },
            1000,
          ),
          noKinds: await reader.pendingQueueSellerIds(
            market,
            { offers: false, revisions: false },
            1000,
          ),
          changeSellers: await changes.pendingSellerIds(market, 1000),
        }));
        if (!read.ok) throw new Error('read failed');
        expect(read.value.handling).toContain(b);
        expect(read.value.handling).not.toContain(a);
        expect(read.value.probation).toContain(a);
        expect(read.value.probation).not.toContain(b);
        expect(read.value.none).toEqual([]);
        expect(read.value.inCategory).toEqual([a]);
        expect(read.value.countInCategory).toBe(1);
        expect(read.value.byIds).toEqual([b]);
        expect(read.value.noIds).toBe(0);
        expect(read.value.offerSellers).toContain(sellerId);
        expect(read.value.noKinds).toEqual([]);
        expect(read.value.changeSellers).toContain(sellerId);
        // The other Market sees none of it (canary).
        const other = marketOf(otherMarketOf(code));
        const across = await persistence.unitOfWork.run(other, async () => ({
          ok: true as const,
          value: {
            reasons: await facts.pendingFirstPublicationsWithReasons(other, ['handling']),
            sellers: await changes.pendingSellerIds(other, 1000),
          },
        }));
        expect(across.ok && across.value.reasons).not.toContain(b);
        expect(across.ok && across.value.sellers).not.toContain(sellerId);
      });

      it('lists through the use case with the live values next to the proposed ones', async () => {
        const offerId = await liveOffer();
        await publish(offerId, 'Dates');
        const change = propose(offerId, {
          at: Temporal.Instant.fromEpochMilliseconds(Date.UTC(2003, 0, 1) + sequence),
        });
        await unit(() => changes.insert(market, change));
        const list = listOf();
        const found = await list.execute(admin(), {
          sellerId,
          reasons: 'certificate-badge',
          submittedFrom: change.state.submittedAt.toString(),
          submittedTo: change.state.submittedAt.add({ seconds: 1 }).toString(),
        });
        expect(found.ok).toBe(true);
        if (!found.ok) return;
        expect(found.value.total).toBe(1);
        expect(found.value.items).toEqual([
          expect.objectContaining({
            changeId: change.state.id,
            proposedDescription: { 'en-AU': 'Call 0412 345 678' },
            proposedTagTypes: ['halal'],
            live: {
              description: { 'en-AU': 'Fresh dates' },
              handling: 'SEALED_ORIGINAL',
              tagTypes: [],
            },
          }),
        ]);
        expect(found.value.items[0]?.offer?.status).toBe('published');
        expect(found.value.items[0]?.product.name).toBe('Dates');
      });

      it('reads the latest first-publication reasons and the open tag types of Offers', async () => {
        const offerId = await liveOffer();
        const store = new PrismaOfferReviewReferralStore(persistence.service, ids);
        const facts = new PrismaOfferReviewQueueFacts(persistence.service);
        const referral = {
          offerId,
          sellerId,
          trigger: 'first-publication' as const,
          policyVersion: 4,
          decidedAt: T0,
        };
        await unit(() =>
          store.record(market, { ...referral, offerVersion: 2, reasons: ['probation'] }),
        );
        await unit(() =>
          store.record(market, {
            ...referral,
            offerVersion: 3,
            reasons: ['handling', 'full-review'],
          }),
        );
        const unknown = uuid7() as Id<'Offer'>;
        const read = await unit(async () => ({
          reasons: await facts.firstPublicationReasons(market, [offerId, unknown]),
          tags: await facts.openTagTypes(market, [offerId]),
        }));
        if (!read.ok) throw new Error('read failed');
        expect([...read.value.reasons]).toEqual([
          [offerId, { offerVersion: 3, reasons: ['handling', 'full-review'] }],
        ]);
        expect(read.value.tags.get(offerId)).toBeUndefined();
        const other = marketOf(otherMarketOf(code));
        const across = await persistence.unitOfWork.run(other, async () => ({
          ok: true as const,
          value: await facts.firstPublicationReasons(other, [offerId]),
        }));
        expect(across.ok && across.value.size).toBe(0);
      });
    });

    describe('end to end: hold, withdraw, approve', () => {
      const contextOf = (population: 'seller' | 'admin', target = market): CallContext =>
        testCallContext(
          target,
          testAuthenticatedActor(target, {
            population,
            accountId: population === 'seller' ? sellerAccount : (uuid7() as Id<'Account'>),
            sessionId: uuid7() as Id<'Session'>,
            sellerId: population === 'seller' ? sellerId : null,
          }),
        );

      function useCases(
        options: { claims?: ClaimQueryBuilder; evaluator?: FakeClaimEvaluator } = {},
      ) {
        const audits: AuditEntry[] = [];
        const audit = {
          record: (_c: CallContext, entry: AuditEntry) => {
            audits.push(entry);
            return Promise.resolve();
          },
        };
        const clock = new FixedClock(Temporal.Now.instant());
        const claims =
          options.claims ??
          new ClaimQueryBuilder({
            products,
            revisions: new PrismaProductRevisionRepository(persistence.service),
            categoryPaths: new PrismaCategoryPathsReader(persistence.service),
          });
        const evaluator =
          options.evaluator ??
          new FakeClaimEvaluator(() => {
            throw new Error('nothing is asked: no tag');
          }, []);
        const outbox = new RecordingOutbox();
        const editReview = prismaOfferEditReview(persistence.service, ids, audit, {
          mode: 'risk-based',
          certificateBadges: 'review',
          emergencyStop: false,
        });
        const decision = {
          unitOfWork: persistence.unitOfWork,
          offers,
          pendingChanges: changes,
          audit,
          clock,
        };
        const check = {
          execute: () => Promise.resolve({ ok: true as const, value: [] }),
        } as unknown as CheckClaimText;
        return {
          audits,
          evaluator,
          remove: new OwnOfferDelete(gate, {
            unitOfWork: persistence.unitOfWork,
            offers,
            products,
            outbox,
            clock,
            editReview,
          }),
          reject: new AdminOfferChangeReject(gate, decision),
          list: listOf(),
          setHandling: new OwnOfferSetHandling(gate, {
            unitOfWork: persistence.unitOfWork,
            offers,
            eligibility: { isEligible: () => Promise.resolve(true) },
            save: { reserveSaves: () => Promise.resolve(null) },
            claims,
            evaluator,
            outbox,
            clock,
            editReview,
          }),
          withdraw: new OwnOfferWithdrawChange(gate, decision),
          approve: new AdminOfferChangeApprove(gate, {
            ...decision,
            eligibility: { isEligible: () => Promise.resolve(true) },
            check,
            claims,
            evaluator,
            outbox,
            ids,
          }),
        };
      }

      /** A held handling change of a new live Offer, made by the seller's use case. */
      async function heldHandling(u: ReturnType<typeof useCases>) {
        const offerId = await liveOffer();
        const held = await u.setHandling.execute(contextOf('seller'), {
          offerId,
          handling: 'REPACKED',
        });
        if (!held.ok || held.value.pendingChangeId === undefined) throw new Error('not held');
        return { offerId, changeId: held.value.pendingChangeId };
      }

      interface ChangeRow {
        readonly status: string;
        readonly superseded_cause: string | null;
        readonly undecided: boolean;
      }
      interface OfferRow {
        readonly handling: string;
        readonly status: string;
        readonly version: number;
      }
      const changeRow = async (changeId: string): Promise<ChangeRow> =>
        (
          await owner.query<ChangeRow>(
            `SELECT status, superseded_cause, decided_at IS NULL AS undecided
             FROM catalog.offer_pending_changes WHERE id = $1`,
            [changeId],
          )
        ).rows[0]!;
      const offerRow = async (offerId: string): Promise<OfferRow> =>
        (
          await owner.query<OfferRow>(
            `SELECT handling, status, version FROM catalog.offers WHERE id = $1`,
            [offerId],
          )
        ).rows[0]!;

      it('supersedes the open change (offer-deleted) in the unit that deletes the Offer', async () => {
        const u = useCases();
        const { offerId, changeId } = await heldHandling(u);
        expect(await u.remove.execute(contextOf('seller'), { offerId })).toEqual({
          ok: true,
          value: {},
        });
        expect(await changeRow(changeId)).toEqual({
          status: 'superseded',
          superseded_cause: 'offer-deleted',
          undecided: false,
        });
        expect(await offerRow(offerId)).toMatchObject({
          status: 'deleted',
          handling: 'SEALED_ORIGINAL',
        });
        expect(u.audits.map((entry) => entry.action)).toContain('catalog.offer-change.superseded');
        // Nothing is left to decide.
        expect(await u.approve.execute(contextOf('admin'), { changeId })).toEqual({
          ok: false,
          error: { code: 'offer-change.not-pending' },
        });
      });

      it('applies nothing when a requested tag type is refused at approval; the change stays pending', async () => {
        const typeCode = code === 'AU' ? 'halal' : 'zz-cert';
        const offerId = await liveOffer();
        const read = await unit(() => offers.findById(market, offerId));
        if (!read.ok || read.value === null) throw new Error('no Offer');
        const evaluator = new FakeClaimEvaluator(
          (query) => refusedDecision(query, 'certificate-expired'),
          [typeCode],
        );
        const claims = new FixedFactsClaimQueryBuilder({
          productId: read.value.state.productId,
          productRevisionId: uuid7() as Id<'ProductRevision'>,
          revisionPublished: true,
          variantIds: [uuid7() as Id<'Variant'>],
          platformCategoryPaths: [],
        });
        const u = useCases({ claims, evaluator });
        const made = OfferPendingChange.propose({
          id: uuid7() as Id<'OfferPendingChange'>,
          marketId: market.marketId,
          offerId,
          sellerId,
          baseOfferVersion: read.value.state.version,
          proposedHandling: 'REPACKED',
          proposedTagTypes: [typeCode],
          reasons: ['certificate-badge', 'handling'],
          policyVersion: 2,
          submittedByAccountId: sellerAccount,
          now: nowInstant(),
        });
        if (!made.ok) throw new Error(made.error.code);
        await unit(() => changes.insert(market, made.value));
        const before = await offerRow(offerId);

        const outcome = await u.approve.execute(contextOf('admin'), {
          changeId: made.value.state.id,
        });
        expect(outcome).toEqual({
          ok: false,
          error: {
            code: 'claim.tag-not-allowed',
            tags: [{ typeCode, reason: 'certificate-expired' }],
          },
        });
        expect(evaluator.calls.length).toBeGreaterThan(0);
        // All or nothing: the handling did not go live, no tag row, the change is still open.
        expect(await offerRow(offerId)).toEqual(before);
        expect(before).toMatchObject({ handling: 'SEALED_ORIGINAL' });
        const tags = await owner.query(`SELECT 1 FROM catalog.offer_tags WHERE offer_id = $1`, [
          offerId,
        ]);
        expect(tags.rows).toEqual([]);
        expect(await changeRow(made.value.state.id)).toEqual({
          status: 'pending',
          superseded_cause: null,
          undecided: true,
        });
        expect(u.audits.map((entry) => entry.action)).not.toContain(
          'catalog.offer-change.approved',
        );
      });

      it('lets exactly one of two concurrent decisions win: approve against withdraw', async () => {
        const u = useCases();
        const { offerId, changeId } = await heldHandling(u);
        const [approved, withdrawn] = await Promise.all([
          u.approve.execute(contextOf('admin'), { changeId }),
          u.withdraw.execute(contextOf('seller'), { offerId }),
        ]);
        const LOST = ['conflict.stale', 'offer-change.not-pending', 'offer-change.not-found'];
        const outcomes = [approved, withdrawn];
        expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
        const loser = outcomes.find((outcome) => !outcome.ok);
        expect(loser !== undefined && !loser.ok && LOST.includes(loser.error.code)).toBe(true);
        const row = await changeRow(changeId);
        const offer = await offerRow(offerId);
        if (approved.ok) {
          expect(row).toMatchObject({ status: 'approved' });
          expect(offer).toMatchObject({ handling: 'REPACKED', status: 'published' });
        } else {
          expect(row).toMatchObject({ status: 'withdrawn' });
          expect(offer).toMatchObject({ handling: 'SEALED_ORIGINAL', status: 'published' });
        }
      });

      it('lets exactly one of two concurrent admin decisions win: approve against reject', async () => {
        const u = useCases();
        const { offerId, changeId } = await heldHandling(u);
        const [approved, rejected] = await Promise.all([
          u.approve.execute(contextOf('admin'), { changeId }),
          u.reject.execute(contextOf('admin'), { changeId, note: 'Not as described' }),
        ]);
        const outcomes = [approved, rejected];
        expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
        const loser = outcomes.find((outcome) => !outcome.ok);
        expect(
          loser !== undefined &&
            !loser.ok &&
            ['conflict.stale', 'offer-change.not-pending'].includes(loser.error.code),
        ).toBe(true);
        expect((await changeRow(changeId)).status).toBe(approved.ok ? 'approved' : 'rejected');
        expect((await offerRow(offerId)).handling).toBe(
          approved.ok ? 'REPACKED' : 'SEALED_ORIGINAL',
        );
      });

      it('never reaches a change from the other Market (approve, reject, withdraw, list)', async () => {
        const u = useCases();
        const { offerId, changeId } = await heldHandling(u);
        const other = marketOf(otherMarketOf(code));
        const notFound = { ok: false, error: { code: 'offer-change.not-found' } };
        expect(await u.approve.execute(contextOf('admin', other), { changeId })).toEqual(notFound);
        expect(
          await u.reject.execute(contextOf('admin', other), { changeId, note: 'Canary' }),
        ).toEqual(notFound);
        expect(await u.withdraw.execute(contextOf('seller', other), { offerId })).toEqual(notFound);
        const listed = await u.list.execute(contextOf('admin', other), { limit: 50 });
        expect(listed.ok).toBe(true);
        expect(listed.ok && listed.value.items.map((item) => item.changeId)).not.toContain(
          changeId,
        );
        // Untouched in its own Market.
        expect(await changeRow(changeId)).toMatchObject({ status: 'pending' });
        expect(await offerRow(offerId)).toMatchObject({ handling: 'SEALED_ORIGINAL' });
      });

      it('holds a handling change, withdraws it, holds again and approves it', async () => {
        const offerId = await liveOffer();
        const u = useCases();
        const held = await u.setHandling.execute(contextOf('seller'), {
          offerId,
          handling: 'REPACKED',
        });
        if (!held.ok) throw new Error(held.error.code);
        expect(held.value).toMatchObject({ applied: false, reasons: ['handling'] });
        const referral = await owner.query(
          `SELECT trigger, reasons, pending_change_id, offer_version
           FROM catalog.offer_review_referrals WHERE offer_id = $1`,
          [offerId],
        );
        expect(referral.rows).toEqual([
          {
            trigger: 'edit',
            reasons: ['handling'],
            pending_change_id: held.value.pendingChangeId,
            offer_version: 4,
          },
        ]);

        const withdrawn = await u.withdraw.execute(contextOf('seller'), { offerId });
        expect(withdrawn.ok && withdrawn.value.status).toBe('withdrawn');

        const again = await u.setHandling.execute(contextOf('seller'), {
          offerId,
          handling: 'FRESH',
        });
        if (!again.ok || again.value.pendingChangeId === undefined) throw new Error('not held');
        const approved = await u.approve.execute(contextOf('admin'), {
          changeId: again.value.pendingChangeId,
        });
        expect(approved).toEqual({
          ok: true,
          value: {
            changeId: again.value.pendingChangeId,
            offerId,
            status: 'approved',
            fields: ['handling'],
          },
        });
        const offer = await owner.query(
          `SELECT handling, status, version FROM catalog.offers WHERE id = $1`,
          [offerId],
        );
        expect(offer.rows).toEqual([{ handling: 'FRESH', status: 'published', version: 7 }]);
        expect(u.audits.map((entry) => entry.action)).toEqual([
          'catalog.offer-change.held',
          'catalog.offer.review-referred',
          'catalog.offer-change.withdrawn',
          'catalog.offer-change.held',
          'catalog.offer.review-referred',
          'catalog.offer-change.approved',
        ]);
      });
    });
  },
);
