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
import { OwnOfferSetHandling } from '../../src/modules/catalog/application/use-cases/own-offer-set-handling.use-case';
import { OwnOfferWithdrawChange } from '../../src/modules/catalog/application/use-cases/own-offer-withdraw-change.use-case';
import { Offer } from '../../src/modules/catalog/domain/offer';
import { OfferPendingChange } from '../../src/modules/catalog/domain/offer-pending-change';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaCategoryPathsReader } from '../../src/modules/catalog/infrastructure/prisma-category-paths.reader';
import { PrismaOfferPendingChangeRepository } from '../../src/modules/catalog/infrastructure/prisma-offer-pending-change.repository';
import { PrismaOfferReviewReferralStore } from '../../src/modules/catalog/infrastructure/prisma-offer-review-referral.store';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaProductRevisionRepository } from '../../src/modules/catalog/infrastructure/prisma-product-revision.repository';
import { prismaOfferEditReview } from '../support/catalog-offer-edit-review-fakes';
import { FakeClaimEvaluator, RecordingOutbox } from '../support/catalog-tag-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
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

    const unit = <T>(work: () => Promise<T>) =>
      persistence.unitOfWork.run(market, async () => ({ ok: true as const, value: await work() }));

    /** A published Offer with handling SEALED_ORIGINAL on a PLATFORM product. */
    async function liveOffer(): Promise<Id<'Offer'>> {
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
        offer.submit({ approvalRequired: false, now: T0 });
        await offers.save(market, offer, seller);
      });
      return offerId;
    }

    const propose = (offerId: Id<'Offer'>, overrides: { at?: Temporal.Instant } = {}) => {
      const made = OfferPendingChange.propose({
        id: uuid7() as Id<'OfferPendingChange'>,
        marketId: market.marketId,
        offerId,
        sellerId,
        baseOfferVersion: 3,
        proposedDescription: { 'en-AU': 'Call 0412 345 678' },
        proposedTagTypes: ['halal'],
        reasons: ['certificate-badge', 'contact-text'],
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
      await expect(
        unit(() =>
          store.record(market, { ...referral, offerVersion: 5, trigger: 'first-publication' }),
        ),
      ).rejects.toThrow();
    });

    describe('end to end: hold, withdraw, approve', () => {
      const contextOf = (population: 'seller' | 'admin'): CallContext =>
        testCallContext(
          market,
          testAuthenticatedActor(market, {
            population,
            accountId: population === 'seller' ? sellerAccount : (uuid7() as Id<'Account'>),
            sessionId: uuid7() as Id<'Session'>,
            sellerId: population === 'seller' ? sellerId : null,
          }),
        );

      function useCases() {
        const audits: AuditEntry[] = [];
        const audit = {
          record: (_c: CallContext, entry: AuditEntry) => {
            audits.push(entry);
            return Promise.resolve();
          },
        };
        const clock = new FixedClock(Temporal.Now.instant());
        const claims = new ClaimQueryBuilder({
          products,
          revisions: new PrismaProductRevisionRepository(persistence.service),
          categoryPaths: new PrismaCategoryPathsReader(persistence.service),
        });
        const evaluator = new FakeClaimEvaluator(() => {
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
