import { Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  InMemoryOfferPendingChanges,
  memoryOfferEditReview,
} from '../../../../../test/support/catalog-offer-edit-review-fakes';
import { InMemoryOfferPostReviews } from '../../../../../test/support/catalog-offer-post-review-fakes';
import { memoryProbation } from '../../../../../test/support/catalog-seller-review-fakes';
import { RecordingOutbox } from '../../../../../test/support/catalog-tag-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { Offer, type OfferState } from '../../domain/offer';
import { OfferPendingChange } from '../../domain/offer-pending-change';
import { OfferPostReview } from '../../domain/offer-post-review';
import { SellerReviewStanding } from '../../domain/seller-review-standing';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferRepository } from '../ports/offer.repository';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
import { OfferPostReviewRefer } from './offer-post-review-refer.use-case';
import { AdminOfferPostReviewApprove } from './offer-post-review-approve.use-case';
import { AdminOfferPostReviewTakeDown } from './offer-post-review-take-down.use-case';
import { AdminOfferPostReviewsBulkApprove } from './offer-post-reviews-bulk-approve.use-case';

// The decisions and the intake of the post-publication review list (risk-based Offer approval
// slice 6), in memory on both Market fixtures. The tables' own rules are in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-25T09:00:00Z');

describe.each(TEST_MARKET_IDS)('the post-publication review list in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0.add({ hours: 2 }));
  const ids = new SequenceIdGenerator(clock);
  const sellerId = ids.next<'Seller'>();
  const productId = ids.next<'Product'>();
  const adminId = ids.next<'Account'>();

  const admin = (accountId: Id<'Account'> = adminId, acting?: Record<string, unknown>) => {
    const base = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    return acting === undefined
      ? base
      : ({ ...base, actor: { ...base.actor, actingAs: acting } } as unknown as CallContext);
  };
  const seller = () =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId,
      }),
    );
  const system = () => testCallContext(market, 'system');

  const offerState = (overrides: Partial<OfferState> = {}): OfferState => {
    const created = Offer.create({
      id: ids.next<'Offer'>(),
      marketId: code,
      sellerId,
      productId,
      sellerSku: 'SKU-1',
      conditionCode: 'new',
      description: { en: 'Fresh' },
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    return {
      ...created.value.state,
      status: 'published',
      listed: true,
      offSaleCauses: [],
      version: 4,
      ...overrides,
    };
  };

  function rig(options: { offer?: Partial<OfferState>; standing?: boolean } = {}) {
    let openUnits = 0;
    const unitOfWork = {
      run: async (_m: MarketContext, body: () => Promise<{ ok: boolean }>) => {
        openUnits += 1;
        try {
          return await body();
        } finally {
          openUnits -= 1;
        }
      },
    } as unknown as UnitOfWork;
    let offer: OfferState | null = offerState(options.offer);
    const savedOffers: OfferState[] = [];
    const offers = {
      findById: (m: MarketContext, id: Id<'Offer'>) =>
        Promise.resolve(
          offer === null || offer.id !== id || offer.marketId !== m.marketId
            ? null
            : Offer.restore(offer),
        ),
      findManyByIds: (m: MarketContext, list: readonly Id<'Offer'>[]) =>
        Promise.resolve(
          offer !== null && offer.marketId === m.marketId && list.includes(offer.id)
            ? [Offer.restore(offer)]
            : [],
        ),
      save: (_m: MarketContext, saved: Offer) => {
        if (openUnits === 0) throw new Error('saved outside a unit');
        savedOffers.push(saved.state);
        offer = saved.state;
        return Promise.resolve(null);
      },
    } as unknown as OfferRepository;
    const postReviews = new InMemoryOfferPostReviews();
    const audits: AuditEntry[] = [];
    const audit: AuditWriter = {
      record: (_c, entry) => {
        if (openUnits === 0) throw new Error('audit outside a unit');
        audits.push(entry);
        return Promise.resolve();
      },
    };
    const outbox = new RecordingOutbox();
    const pendingChanges = new InMemoryOfferPendingChanges();
    const edit = memoryOfferEditReview({ ids, pendingChanges });
    const probation = memoryProbation();
    if (options.standing === true) {
      const start = SellerReviewStanding.start({ marketId: code, sellerId, now: T0 });
      probation.standings.rows.set(`${code}|${sellerId}`, { ...start.state, trustedAt: T0 });
    }
    const approve = new AdminOfferPostReviewApprove(gate, {
      unitOfWork,
      postReviews,
      audit,
      clock,
    });
    const takeDown = new AdminOfferPostReviewTakeDown(gate, {
      unitOfWork,
      postReviews,
      offers,
      pendingChanges,
      editReview: edit.review,
      probation: probation.probation,
      audit,
      outbox,
      clock,
    });
    const policy = {
      locales: () => ({ default: 'en', supported: ['en'] }),
    } as unknown as CatalogMarketPolicy;
    const ownReader = {
      productLabels: (_m: MarketContext, list: readonly string[]) =>
        Promise.resolve(list.map((id) => ({ productId: id, name: 'Dates' }))),
    } as unknown as OwnCatalogReader;
    const bulk = new AdminOfferPostReviewsBulkApprove(gate, {
      postReviewApprove: approve,
      unitOfWork,
      postReviews,
      offers,
      ownReader,
      policy,
    });
    const refer = new OfferPostReviewRefer(gate, { unitOfWork, offers, postReviews, clock, ids });
    /** An open row of the Offer, stored. */
    const openRow = (reason: 'sample' | 'price-no-reference' = 'price-no-reference') => {
      const opened = OfferPostReview.open({
        id: ids.next<'OfferPostReview'>(),
        marketId: code,
        offerId: offer!.id,
        sellerId,
        productId,
        reason,
        sample: reason === 'sample' ? { percent: 5, doubled: false } : null,
        now: T0,
      });
      if (!opened.ok) throw new Error(opened.error.code);
      postReviews.rows.set(opened.value.state.id, opened.value.state);
      return opened.value.state;
    };
    return {
      approve,
      takeDown,
      bulk,
      refer,
      postReviews,
      pendingChanges,
      audits,
      outbox,
      probation,
      savedOffers,
      offer: () => offer!,
      openRow,
    };
  }

  const takeDownBody = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    version: 1,
    reasonCode: 'description-claim',
    misconduct: false,
    note: 'Claims a certificate',
    ...extra,
  });

  describe('catalog.offer-post-review-approve', () => {
    it('closes the open row at the version seen; the Offer stays; the note is never audited', async () => {
      const r = rig();
      const row = r.openRow();
      const outcome = await r.approve.execute(admin(), {
        id: row.id,
        version: 1,
        note: 'Looks fine',
      });
      expect(outcome).toEqual({
        ok: true,
        value: { id: row.id, offerId: row.offerId, status: 'approved', version: 2 },
      });
      expect(r.postReviews.rows.get(row.id)).toMatchObject({
        status: 'approved',
        decidedByAccountId: adminId,
        note: 'Looks fine',
      });
      expect(r.savedOffers).toEqual([]);
      expect(r.audits).toEqual([
        expect.objectContaining({
          action: 'catalog.offer.post-review-approved',
          after: { postReviewId: row.id },
        }),
      ]);
      expect(JSON.stringify(r.audits)).not.toContain('Looks fine');
    });

    it('refuses a stale version, a decided row and an unknown one', async () => {
      const r = rig();
      const row = r.openRow();
      expect(await r.approve.execute(admin(), { id: row.id, version: 2 })).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
      await r.approve.execute(admin(), { id: row.id, version: 1 });
      expect(await r.approve.execute(admin(), { id: row.id, version: 2 })).toEqual({
        ok: false,
        error: { code: 'post-review.not-open' },
      });
      expect(
        await r.approve.execute(admin(), { id: ids.next<'OfferPostReview'>(), version: 1 }),
      ).toEqual({ ok: false, error: { code: 'post-review.not-found' } });
    });

    it('never reads a row of another Market', async () => {
      const r = rig();
      const row = r.openRow();
      r.postReviews.rows.set(row.id, {
        ...row,
        marketId: (code === 'AU' ? 'ZZ' : 'AU') as MarketId,
      });
      expect(await r.approve.execute(admin(), { id: row.id, version: 1 })).toEqual({
        ok: false,
        error: { code: 'post-review.not-found' },
      });
    });

    it('refuses an admin behind one of the submits, and any Login-as-Seller session', async () => {
      const r = rig();
      const row = r.openRow();
      r.postReviews.submitters.set(row.offerId, new Set([adminId]));
      expect(await r.approve.execute(admin(), { id: row.id, version: 1 })).toEqual({
        ok: false,
        error: { code: 'post-review.own-submission' },
      });
      // Any Login-as-Seller session is refused, whoever it acts for, as the take-down is (N2).
      const other = ids.next<'Account'>();
      for (const acting of [sellerId, ids.next<'Seller'>()]) {
        expect(
          await r.approve.execute(admin(other, { adminAccountId: other, sellerId: acting }), {
            id: row.id,
            version: 1,
          }),
        ).toEqual({ ok: false, error: { code: 'access.denied' } });
      }
      expect(r.postReviews.rows.get(row.id)?.status).toBe('open');
    });

    it('refuses a seller and a closed body', async () => {
      const r = rig();
      const row = r.openRow();
      expect(await r.approve.execute(seller(), { id: row.id, version: 1 })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(
        await r.approve.execute(admin(), { id: row.id, version: 1, misconduct: true } as never),
      ).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'misconduct', code: 'unknown' }] },
      });
    });
  });

  describe('catalog.offer-post-review-take-down', () => {
    it('takes the Offer off sale, closes the row and audits codes only', async () => {
      const r = rig();
      const row = r.openRow();
      const outcome = await r.takeDown.execute(admin(), takeDownBody(row.id));
      expect(outcome).toEqual({
        ok: true,
        value: { id: row.id, offerId: row.offerId, status: 'taken-down', version: 2 },
      });
      expect(r.offer()).toMatchObject({ status: 'changes-needed', listed: false });
      expect(r.postReviews.rows.get(row.id)).toMatchObject({
        status: 'taken-down',
        decisionReasonCode: 'description-claim',
        misconduct: false,
      });
      expect(r.outbox.types).toEqual([
        'catalog.offer-changes-requested.v1',
        'catalog.offer-listing-changed.v1',
      ]);
      expect(r.audits).toEqual([
        expect.objectContaining({
          action: 'catalog.offer.taken-down',
          after: { postReviewId: row.id, reasonCode: 'description-claim', misconduct: false },
        }),
      ]);
      expect(JSON.stringify([r.audits, r.outbox.appended])).not.toContain('Claims a certificate');
      expect(r.probation.audits).toEqual([]);
    });

    it('supersedes the held edit of the Offer with the cause taken-down', async () => {
      const r = rig();
      const row = r.openRow();
      const proposed = OfferPendingChange.propose({
        id: ids.next<'OfferPendingChange'>(),
        marketId: code,
        offerId: row.offerId,
        sellerId,
        baseOfferVersion: 4,
        proposedHandling: 'REPACKED',
        reasons: ['handling'],
        policyVersion: 4,
        submittedByAccountId: ids.next<'Account'>(),
        now: T0,
      });
      if (!proposed.ok) throw new Error(proposed.error.code);
      r.pendingChanges.rows.set(proposed.value.state.id, proposed.value.state);
      await r.takeDown.execute(admin(), takeDownBody(row.id));
      expect(r.pendingChanges.rows.get(proposed.value.state.id)).toMatchObject({
        status: 'superseded',
        supersededCause: 'taken-down',
      });
    });

    it('revokes Trusted on misconduct (and starts a standing for a seller with none)', async () => {
      const trusted = rig({ standing: true });
      const row = trusted.openRow();
      await trusted.takeDown.execute(admin(), takeDownBody(row.id, { misconduct: true }));
      expect(trusted.probation.audits.map((entry) => entry.action)).toContain(
        'catalog.seller-review.trust-revoked',
      );
      const stored = trusted.probation.standings.rows.get(`${code}|${sellerId}`);
      expect(stored?.trustedAt ?? null).toBeNull();

      const none = rig();
      const other = none.openRow();
      expect(
        (await none.takeDown.execute(admin(), takeDownBody(other.id, { misconduct: true }))).ok,
      ).toBe(true);
      expect(none.probation.standings.rows.get(`${code}|${sellerId}`)).toBeDefined();
    });

    it('revokes just after a racing revocation stamped at or after the clock (Hassan L2)', async () => {
      for (const lostAt of [clock.now(), clock.now().add({ minutes: 1 })]) {
        const r = rig({ standing: true });
        const key = `${code}|${sellerId}`;
        const held = r.probation.standings.rows.get(key)!;
        r.probation.standings.rows.set(key, { ...held, trustLostAt: lostAt });
        const row = r.openRow();
        expect(
          (await r.takeDown.execute(admin(), takeDownBody(row.id, { misconduct: true }))).ok,
        ).toBe(true);
        expect(r.probation.standings.rows.get(key)?.trustLostAt).toEqual(
          lostAt.add({ milliseconds: 1 }),
        );
      }
    });

    it('refuses an Offer that is not published (offer.not-live), changing nothing', async () => {
      for (const status of ['changes-needed', 'pending-first-publish', 'deleted'] as const) {
        const r = rig({ offer: { status, listed: false } });
        const row = r.openRow();
        expect(await r.takeDown.execute(admin(), takeDownBody(row.id))).toEqual({
          ok: false,
          error: { code: 'offer.not-live' },
        });
        expect(r.postReviews.rows.get(row.id)?.status).toBe('open');
        expect([r.savedOffers, r.outbox.types, r.audits]).toEqual([[], [], []]);
        // Approve still closes such a row.
        expect((await r.approve.execute(admin(), { id: row.id, version: 1 })).ok).toBe(true);
      }
    });

    it('refuses a stale version, a decided row, and its own submission', async () => {
      const r = rig();
      const row = r.openRow();
      expect(await r.takeDown.execute(admin(), takeDownBody(row.id, { version: 3 }))).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
      r.postReviews.submitters.set(row.offerId, new Set([adminId]));
      expect(await r.takeDown.execute(admin(), takeDownBody(row.id))).toEqual({
        ok: false,
        error: { code: 'post-review.own-submission' },
      });
      r.postReviews.submitters.clear();
      await r.approve.execute(admin(), { id: row.id, version: 1 });
      expect(await r.takeDown.execute(admin(), takeDownBody(row.id, { version: 2 }))).toEqual({
        ok: false,
        error: { code: 'post-review.not-open' },
      });
    });

    it('is refused in any Login-as-Seller session, whoever it acts for', async () => {
      const r = rig();
      const row = r.openRow();
      const other = ids.next<'Account'>();
      expect(
        await r.takeDown.execute(
          admin(other, { adminAccountId: other, sellerId: ids.next<'Seller'>() }),
          takeDownBody(row.id),
        ),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(r.postReviews.rows.get(row.id)?.status).toBe('open');
    });

    it('needs a note, a known reason code and a boolean misconduct', async () => {
      const r = rig();
      const row = r.openRow();
      const refused = async (patch: Record<string, unknown>) =>
        r.takeDown.execute(admin(), { ...takeDownBody(row.id), ...patch });
      expect(await refused({ note: undefined })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'note', code: 'required' }] },
      });
      expect(await refused({ note: 'x'.repeat(2001) })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'note', code: 'length' }] },
      });
      expect(await refused({ reasonCode: 'price' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'reasonCode', code: 'value' }] },
      });
      expect(await refused({ misconduct: 'no' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'misconduct', code: 'type' }] },
      });
    });

    it('answers conflict.stale when the row changed between the read and the write', async () => {
      const r = rig();
      const row = r.openRow();
      const save = r.postReviews.save.bind(r.postReviews);
      r.postReviews.save = () => Promise.resolve(false);
      expect(await r.takeDown.execute(admin(), takeDownBody(row.id))).toEqual({
        ok: false,
        error: { code: 'conflict.stale' },
      });
      r.postReviews.save = save;
    });
  });

  describe('catalog.offer-post-reviews-bulk-approve', () => {
    it('approves each row in order, skipping what is not decidable now, with the product name', async () => {
      const r = rig();
      const open = r.openRow();
      const unknown = ids.next<'OfferPostReview'>();
      const outcome = await r.bulk.execute(admin(), {
        items: [
          { id: open.id, version: 1 },
          { id: unknown, version: 1 },
        ],
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.value.counts).toEqual({ done: 1, skipped: 1, failed: 0 });
      expect(outcome.value.results).toEqual([
        expect.objectContaining({ id: open.id, outcome: 'done', name: 'Dates' }),
        expect.objectContaining({
          id: unknown,
          outcome: 'skipped',
          reason: 'post-review.not-found',
        }),
      ]);
    });

    it('skips an own submission rather than failing it', async () => {
      const r = rig();
      const row = r.openRow();
      r.postReviews.submitters.set(row.offerId, new Set([adminId]));
      const outcome = await r.bulk.execute(admin(), { items: [{ id: row.id, version: 1 }] });
      expect(outcome.ok && outcome.value.results[0]).toMatchObject({
        outcome: 'skipped',
        reason: 'post-review.own-submission',
      });
    });

    it('refuses a seller, and any Login-as-Seller session', async () => {
      const r = rig();
      expect(await r.bulk.execute(seller(), { items: [] })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      const row = r.openRow();
      const other = ids.next<'Account'>();
      expect(
        await r.bulk.execute(
          admin(other, { adminAccountId: other, sellerId: ids.next<'Seller'>() }),
          {
            items: [{ id: row.id, version: 1 }],
          },
        ),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(r.postReviews.rows.get(row.id)?.status).toBe('open');
    });
  });

  describe('catalog.offer-post-review-refer (pricing, through the facade)', () => {
    const recordId = () => ids.next<'Record'>() as string;

    it('opens a row, adds a second reason, and changes nothing on a redelivery', async () => {
      const r = rig();
      const offerId = r.offer().id;
      const first = recordId();
      const refer = (reason: string, sourceRef: string) =>
        r.refer.execute(system(), { offerId, sellerId, reason, sourceRef });
      expect(await refer('price-no-reference', first)).toEqual({
        ok: true,
        value: { code: 'post-review.opened' },
      });
      expect(await refer('price-no-reference', first)).toEqual({
        ok: true,
        value: { code: 'post-review.duplicate' },
      });
      expect(await refer('price-recheck-outside', first)).toEqual({
        ok: true,
        value: { code: 'post-review.extended' },
      });
      expect(r.postReviews.ofOffer(offerId)).toEqual([
        expect.objectContaining({
          marketId: code,
          status: 'open',
          reasons: ['price-no-reference', 'price-recheck-outside'],
          samplePercent: null,
          version: 2,
        }),
      ]);
    });

    it('opens a new row when the Offer was reviewed before', async () => {
      const r = rig();
      const decided = r.openRow();
      await r.approve.execute(admin(), { id: decided.id, version: 1 });
      expect(
        await r.refer.execute(system(), {
          offerId: decided.offerId,
          sellerId,
          reason: 'price-reference-unavailable',
          sourceRef: recordId(),
        }),
      ).toEqual({ ok: true, value: { code: 'post-review.opened' } });
      expect(r.postReviews.ofOffer(decided.offerId).map((row) => row.status)).toEqual([
        'approved',
        'open',
      ]);
    });

    it('writes nothing for an unknown or deleted Offer, or another seller', async () => {
      const deleted = rig({ offer: { status: 'deleted', listed: false } });
      const cases = [
        { r: deleted, offerId: deleted.offer().id, seller: sellerId },
        { r: rig(), offerId: ids.next<'Offer'>(), seller: sellerId },
      ];
      const mismatch = rig();
      cases.push({ r: mismatch, offerId: mismatch.offer().id, seller: ids.next<'Seller'>() });
      for (const { r, offerId, seller: s } of cases) {
        expect(
          await r.refer.execute(system(), {
            offerId,
            sellerId: s,
            reason: 'price-no-reference',
            sourceRef: recordId(),
          }),
        ).toEqual({ ok: true, value: { code: 'post-review.offer-gone' } });
        expect(r.postReviews.rows.size).toBe(0);
      }
    });

    it('takes only the system actor, pricing reasons and a record id', async () => {
      const r = rig();
      const input = {
        offerId: r.offer().id,
        sellerId,
        reason: 'price-no-reference',
        sourceRef: recordId(),
      };
      expect(await r.refer.execute(admin(), input)).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await r.refer.execute(system(), { ...input, reason: 'sample' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'reason', code: 'value' }] },
      });
      expect(await r.refer.execute(system(), { ...input, sourceRef: 'offer-version:3' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'sourceRef', code: 'format' }] },
      });
    });

    it('asks again after a lost race, then answers conflict.retry', async () => {
      const r = rig();
      let fails = 2;
      const insert = r.postReviews.insert.bind(r.postReviews);
      r.postReviews.insert = (m, review) => {
        if (fails > 0) {
          fails -= 1;
          return Promise.reject(new StaleAggregateError('offer-post-review', review.state.id));
        }
        return insert(m, review);
      };
      const input = {
        offerId: r.offer().id,
        sellerId,
        reason: 'price-no-reference',
        sourceRef: recordId(),
      };
      expect(await r.refer.execute(system(), input)).toEqual({
        ok: true,
        value: { code: 'post-review.opened' },
      });
      fails = 5;
      expect(
        await r.refer.execute(system(), {
          ...input,
          offerId: rig().offer().id,
          sourceRef: recordId(),
        }),
      ).toEqual({ ok: true, value: { code: 'post-review.offer-gone' } });
      const other = rig();
      other.postReviews.insert = () =>
        Promise.reject(new StaleAggregateError('offer-post-review', 'x'));
      expect(
        await other.refer.execute(system(), {
          ...input,
          offerId: other.offer().id,
          sourceRef: recordId(),
        }),
      ).toEqual({ ok: false, error: { code: 'conflict.retry' } });
    });
  });
});
