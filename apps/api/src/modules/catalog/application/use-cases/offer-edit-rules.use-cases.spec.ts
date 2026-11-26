import { InMemoryOfferPostReviews } from '../../../../../test/support/catalog-offer-post-review-fakes';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, MarketId, Result } from '@mondapac/shared-kernel';
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
import {
  FakeClaimEvaluator,
  FixedFactsClaimQueryBuilder,
  RecordingOutbox,
  activeTagState,
  allowedDecision,
  refusedDecision,
} from '../../../../../test/support/catalog-tag-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditEntry } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { Offer, type OfferState } from '../../domain/offer';
import type { OfferPendingChangeState } from '../../domain/offer-pending-change';
import type { ClaimFacts, OfferTagState } from '../../domain/offer-tag';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { CheckClaimText } from '../claim-text/check-claim-text.service';
import type { OfferReviewFactsRead, OfferReviewSettings } from '../ports/offer-review';
import type { OfferRepository } from '../ports/offer.repository';
import type { ProductRepository } from '../ports/product.repository';
import { AdminOfferChangeApprove } from './admin-offer-change-approve.use-case';
import { AdminOfferChangeReject } from './admin-offer-change-reject.use-case';
import { AdminOfferChangeRequestChanges } from './admin-offer-change-request-changes.use-case';
import { decideHeldChange, decidesOwnSubmission } from '../offer-change-decision';
import { AdminOfferChangesList } from './admin-offer-changes-list.use-case';
import { OwnOfferRead } from './own-offer-read.use-case';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
import { OwnOfferAddTag } from './own-offer-add-tag.use-case';
import { OwnOfferDelete } from './own-offer-delete.use-case';
import { OwnOfferEdit } from './own-offer-edit.use-case';
import { OwnOfferSetHandling } from './own-offer-set-handling.use-case';
import { OwnOfferWithdrawChange } from './own-offer-withdraw-change.use-case';

// The edit rules of a live Offer (risk-based Offer approval, slice 2c; ADR-0051) in memory, on both
// Market fixtures: the seller's edit, handling and badge on a published Offer, held or applied by
// the Market's review mode; the seller's withdrawal; the admin's decisions (approve all or
// nothing, request changes, reject); delete and replacePending supersede. A unit that ends with an
// error rolls back here as it does in the database. The database behaviour is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-25T00:00:00Z');

const RISK: OfferReviewSettings = {
  mode: 'risk-based',
  certificateBadges: 'review',
  emergencyStop: false,
};
const ALL: OfferReviewSettings = {
  mode: 'all',
  certificateBadges: 'automatic',
  emergencyStop: false,
};
const OFF: OfferReviewSettings = { mode: 'off', certificateBadges: 'review', emergencyStop: false };

describe.each([
  ['AU', 'halal'],
  ['ZZ', 'zz-cert'],
] as const)('edit rules of a live Offer in market %s', (code, typeCode) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const locale = policy.locales(market).default;
  const condition = policy.conditions(market)[0]!;
  const sellerId = ids.next<'Seller'>();
  const variantIds = [ids.next<'Variant'>()];
  const certificate = {
    certificateId: ids.next(),
    versionId: ids.next(),
    typeRevisionId: ids.next(),
  };
  const REFUSED_TYPE = 'refused-type';

  const sellerContext = (
    owner = sellerId,
    accountId = ids.next<'Account'>(),
    target: MarketContext = market,
  ): CallContext =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population: 'seller',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId: owner,
      }),
    );
  const adminContext = (
    accountId = ids.next<'Account'>(),
    target: MarketContext = market,
  ): CallContext =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population: 'admin',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
  /**
   * An admin context with the reserved acting-as marker (SEL-08, identity design 3.4 row 6: the
   * admin stays the actor). Not minted: only the probes below take it.
   */
  const actingAdmin = (actingAs: {
    readonly accountId: Id<'Account'>;
    readonly sellerId: Id<'Seller'> | null;
  }): CallContext => {
    const context = adminContext();
    return { ...context, actor: { ...context.actor, actingAs } } as unknown as CallContext;
  };
  const otherMarket: MarketContext = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');

  const liveOffer = (overrides: Partial<OfferState> = {}): OfferState => ({
    id: ids.next<'Offer'>(),
    marketId: code as MarketId,
    sellerId,
    productId: ids.next<'Product'>(),
    sellerSku: 'SKU-1',
    conditionCode: condition,
    description: { [locale]: 'Lamb shoulder, 1 kg' },
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

  function rig(
    options: {
      offer?: OfferState;
      tags?: OfferTagState[];
      settings?: OfferReviewSettings | 'fail';
      facts?: Partial<OfferReviewFactsRead> | 'fail';
    } = {},
  ) {
    let settings: OfferReviewSettings | 'fail' = options.settings ?? RISK;
    const initial = options.offer ?? liveOffer();
    let current: { state: OfferState; tags: readonly OfferTagState[] } = {
      state: initial,
      tags: options.tags ?? [],
    };
    const pendingChanges = new InMemoryOfferPendingChanges();
    let openUnits = 0;
    const unitAudits: AuditEntry[] = [];
    // A unit that ends with an error or throws rolls back the Offer and the changes.
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => {
        if (openUnits > 0) throw new Error('units do not nest');
        const offerBefore = current;
        const rowsBefore = new Map<string, OfferPendingChangeState>(pendingChanges.rows);
        const auditsBefore = unitAudits.length;
        openUnits += 1;
        try {
          const result = await work();
          if (!result.ok) throw Object.assign(new Error('rollback'), { result });
          return result;
        } catch (error) {
          current = offerBefore;
          pendingChanges.rows.clear();
          for (const [id, row] of rowsBefore) pendingChanges.rows.set(id, row);
          unitAudits.length = auditsBefore;
          const carried = (error as { result?: Result<T, E> }).result;
          if (carried !== undefined) return carried;
          throw error;
        } finally {
          openUnits -= 1;
        }
      },
    } as unknown as UnitOfWork;
    const memory = memoryOfferEditReview({
      ids,
      settings: () => settings,
      ...(options.facts === undefined ? {} : { facts: options.facts }),
      pendingChanges,
      inUnit: () => openUnits > 0,
    });
    const evaluator = new FakeClaimEvaluator(
      (query) =>
        query.typeCode === REFUSED_TYPE
          ? refusedDecision(query, 'no-certificate')
          : allowedDecision(query, certificate),
      [typeCode, REFUSED_TYPE],
    );
    const facts: ClaimFacts = {
      productId: initial.productId,
      productRevisionId: ids.next<'ProductRevision'>(),
      revisionPublished: true,
      variantIds,
      platformCategoryPaths: [[ids.next<'Category'>()]],
    };
    const claims = new FixedFactsClaimQueryBuilder(facts);
    const outbox = new RecordingOutbox();
    const offers: OfferRepository = {
      add: () => Promise.reject(new Error('unused')),
      listOnProduct: () => Promise.resolve([]),
      listPendingReview: () => Promise.resolve([]),
      findManyByIds: (m, wanted) =>
        Promise.resolve(
          wanted.includes(current.state.id) && current.state.marketId === m.marketId
            ? [Offer.restore(current.state, current.tags)]
            : [],
        ),
      findById: (m, id) =>
        Promise.resolve(
          current.state.id === id && current.state.marketId === m.marketId
            ? Offer.restore(current.state, current.tags)
            : null,
        ),
      save: (_m, offer) => {
        if (openUnits === 0) throw new Error('saved outside a unit');
        if (!offer.hasChanges) return Promise.resolve(null);
        if (offer.persistedVersion !== current.state.version) {
          throw new StaleAggregateError('offer', offer.state.id);
        }
        current = { state: offer.state, tags: offer.tags.filter((t) => t.status !== 'removed') };
        return Promise.resolve(null);
      },
    };
    const eligibility = { isEligible: () => Promise.resolve(true) };
    const save = { reserveSaves: () => Promise.resolve(null) };
    // The claim vocabulary; a test may grow it between the hold and the approval.
    const claimWords = ['certified halal'];
    const check = {
      execute: (_c: CallContext, texts: readonly { locale: string; text: string }[]) =>
        Promise.resolve({
          ok: true as const,
          value: texts.map((t) =>
            claimWords.some((word) => t.text.includes(word))
              ? {
                  code: 'claim-text.found' as const,
                  field: 'offer.description' as const,
                  ref: null,
                  locale: t.locale,
                  hits: [],
                }
              : {
                  code: 'clean' as const,
                  field: 'offer.description' as const,
                  ref: null,
                  locale: t.locale,
                },
          ),
        }),
    } as unknown as CheckClaimText;
    const products = {
      findById: (_m: MarketContext, id: Id<'Product'>) =>
        Promise.resolve({ state: { id, scope: 'PLATFORM', status: 'published', pausedAt: null } }),
    } as unknown as ProductRepository;
    const audit: AuditWriter = {
      record: (_c, entry) => {
        if (openUnits === 0) throw new Error('audited outside a unit');
        unitAudits.push(entry);
        return Promise.resolve();
      },
    };
    const deps = { unitOfWork, offers, eligibility, save, claims, evaluator, outbox, clock };
    const decisionDeps = { unitOfWork, offers, pendingChanges, audit, clock };
    const approve = new AdminOfferChangeApprove(gate, {
      ...decisionDeps,
      eligibility,
      check,
      claims,
      evaluator,
      outbox,
      ids,
    });
    const requestChanges = new AdminOfferChangeRequestChanges(gate, decisionDeps);
    const reject = new AdminOfferChangeReject(gate, decisionDeps);
    return {
      edit: new OwnOfferEdit(gate, { ...deps, check, policy, editReview: memory.review }),
      setHandling: new OwnOfferSetHandling(gate, { ...deps, editReview: memory.review }),
      addTag: new OwnOfferAddTag(gate, { ...deps, ids, editReview: memory.review }),
      remove: new OwnOfferDelete(gate, {
        unitOfWork,
        offers,
        products,
        outbox,
        clock,
        editReview: memory.review,
      }),
      withdraw: new OwnOfferWithdrawChange(gate, decisionDeps),
      approve,
      requestChanges,
      reject,
      decide: (
        c: CallContext,
        target: Parameters<typeof decideHeldChange>[2],
        decision: Parameters<typeof decideHeldChange>[3],
      ) => decideHeldChange(decisionDeps, c, target, decision),
      /** The use cases' own steps without the gate, for a context the gate cannot mint yet. */
      list: new AdminOfferChangesList(gate, {
        unitOfWork,
        pendingChanges,
        offers,
        ownReader: {
          productLabels: () =>
            Promise.resolve([
              {
                productId: current.state.productId,
                productCode: 'P1',
                typeCode: 'simple',
                name: 'Lamb',
              },
            ]),
        } as unknown as OwnCatalogReader,
        policy: {
          locales: () => ({ default: locale, allowed: [locale] }),
        } as unknown as CatalogMarketPolicy,
        sellerNames: { storeNames: () => Promise.resolve(new Map()) },
        storeSearch: {
          sellersMatching: () => Promise.resolve({ sellerIds: [], capped: false }),
        },
        productApproveProbe: { execute: () => Promise.resolve({ ok: true, value: undefined }) },
      }),
      /** The seller's single Offer read (its latest held change, as the seller is told it). */
      read: new OwnOfferRead(gate, {
        unitOfWork,
        offers,
        ownReader: {
          productLabels: () => Promise.resolve([]),
          sellUnitsOf: () => Promise.resolve([]),
        } as unknown as OwnCatalogReader,
        policy: {
          locales: () => ({ default: locale, allowed: [locale] }),
        } as unknown as CatalogMarketPolicy,
        pendingChanges,
        postReviews: new InMemoryOfferPostReviews(),
      }),
      offerId: initial.id,
      current: () => current,
      changes: () => [...pendingChanges.rows.values()],
      referrals: memory.referrals,
      audits: () => [...memory.audits, ...unitAudits].map((entry) => entry.action),
      auditEntries: () => [...memory.audits, ...unitAudits],
      claimWords,
      /** Puts the Offer in a state no use case reaches here (a test of a guard). */
      force: (state: Partial<OfferState>) => {
        current = { ...current, state: { ...current.state, ...state } };
      },
      /** Stores a held change as it is, without the domain's checks (a stored row). */
      store: (state: OfferPendingChangeState) => pendingChanges.rows.set(state.id, state),
      settingsReads: memory.settingsReads,
      factsAsked: memory.factsAsked,
      evaluator,
      outbox,
      setSettings: (next: OfferReviewSettings | 'fail') => (settings = next),
    };
  }

  const form = (r: { offerId: string }, text: string, extra: Record<string, unknown> = {}) => ({
    offerId: r.offerId,
    sellerSku: 'SKU-1',
    conditionCode: condition,
    description: { [locale]: text },
    ...extra,
  });
  const CONTACT = 'Call 0412 345 678 for bulk';

  describe('own-offer.edit', () => {
    it('applies a clean description at once in risk-based mode with an edit referral', async () => {
      const r = rig();
      const outcome = await r.edit.execute(sellerContext(), form(r, 'Now 2 kg'));
      expect(outcome).toEqual({
        ok: true,
        value: { changedFields: ['description'], applied: true },
      });
      expect(r.current().state.description).toEqual({ [locale]: 'Now 2 kg' });
      expect(r.changes()).toEqual([]);
      expect(r.referrals).toEqual([
        expect.objectContaining({
          trigger: 'edit',
          reasons: [],
          pendingChangeId: null,
          offerVersion: 5,
        }),
      ]);
      expect(r.audits()).toEqual(['catalog.offer.review-referred']);
    });

    it('holds contact text (R5), applies the SKU of the same request, raises the version once', async () => {
      const r = rig();
      const outcome = await r.edit.execute(
        sellerContext(),
        form(r, CONTACT, { sellerSku: 'SKU-2' }),
      );
      if (!outcome.ok) throw new Error(outcome.error.code);
      expect(outcome.value).toMatchObject({
        changedFields: ['sellerSku'],
        applied: false,
        reasons: ['contact-text'],
      });
      const live = r.current().state;
      expect(live).toMatchObject({
        sellerSku: 'SKU-2',
        status: 'published',
        listed: true,
        version: 5,
      });
      expect(live.description).toEqual({ [locale]: 'Lamb shoulder, 1 kg' });
      const [held] = r.changes();
      expect(held).toMatchObject({
        id: outcome.value.pendingChangeId,
        status: 'pending',
        baseOfferVersion: 4,
        proposedDescription: { [locale]: CONTACT },
        proposedHandling: null,
        proposedTagTypes: [],
        reasons: ['contact-text'],
        policyVersion: 4,
      });
      expect(r.referrals).toEqual([
        expect.objectContaining({
          trigger: 'edit',
          reasons: ['contact-text'],
          pendingChangeId: held!.id,
          offerVersion: 5,
        }),
      ]);
      expect(r.audits()).toEqual(['catalog.offer-change.held', 'catalog.offer.review-referred']);
    });

    it('holds every watched change in mode all, and nothing in mode off', async () => {
      const all = rig({ settings: ALL });
      const held = await all.edit.execute(sellerContext(), form(all, 'Clean text'));
      expect(held.ok && held.value).toMatchObject({ applied: false, reasons: ['held-for-review'] });
      const off = rig({ settings: OFF });
      const applied = await off.edit.execute(sellerContext(), form(off, CONTACT));
      expect(applied.ok && applied.value).toEqual({
        changedFields: ['description'],
        applied: true,
      });
      expect(off.changes()).toEqual([]);
    });

    it('tells the seller held-for-review for a stop or R7, while the row and the admin list keep the codes (Hassan S1)', async () => {
      const r = rig({ facts: { emergencyStop: true, sensitiveCategory: true } });
      const held = await r.edit.execute(sellerContext(), form(r, 'Call 0412 345 678'));
      expect(held.ok && held.value).toMatchObject({
        applied: false,
        reasons: ['contact-text', 'held-for-review'],
      });
      expect(JSON.stringify(held)).not.toMatch(/emergency-stop|sensitive-category/);
      expect(r.changes()[0]?.reasons).toEqual([
        'emergency-stop',
        'contact-text',
        'sensitive-category',
      ]);
      const page = await r.list.execute(adminContext(), {});
      expect(page.ok && page.value.items[0]?.reasons).toEqual([
        'emergency-stop',
        'contact-text',
        'sensitive-category',
      ]);
      // The seller's own read of the change says the same as the edit answer (Hassan S1) and
      // carries no review flag or standing (Sajad G2).
      const read = await r.read.execute(sellerContext(), { offerId: r.offerId });
      expect(read.ok && read.value.pendingChange?.reasons).toEqual([
        'contact-text',
        'held-for-review',
      ]);
      expect(JSON.stringify(read)).not.toMatch(
        /emergency-stop|sensitive-category|fullReview|trustedFromStart|reviewStop|probation|standing|trustedAt|epoch/,
      );
      expect(JSON.stringify(held)).not.toMatch(
        /fullReview|trustedFromStart|reviewStop|probation|standing|trustedAt|epoch/,
      );
    });

    it('holds a watched change during an emergency stop, even in mode off (R0)', async () => {
      const r = rig({ settings: { ...OFF, emergencyStop: true } });
      const held = await r.edit.execute(sellerContext(), form(r, 'Clean text'));
      expect(held.ok && held.value).toMatchObject({ applied: false, reasons: ['held-for-review'] });
      expect(r.changes()).toHaveLength(1);
      // A field the rules never watch still applies at once.
      const sku = rig({ settings: { ...OFF, emergencyStop: true } });
      const applied = await sku.edit.execute(
        sellerContext(),
        form(sku, 'Lamb shoulder, 1 kg', { sellerSku: 'SKU-9' }),
      );
      expect(applied.ok && applied.value).toMatchObject({ applied: true });
      expect(sku.changes()).toEqual([]);
    });

    it('holds a watched change during a seller or category stop, even in mode off (R0, slice 4)', async () => {
      const r = rig({ settings: OFF, facts: { emergencyStop: true } });
      const held = await r.edit.execute(sellerContext(), form(r, 'Clean text'));
      expect(held.ok && held.value).toMatchObject({ applied: false, reasons: ['held-for-review'] });
      // The facts are asked for the Offer's own seller and product.
      expect(r.factsAsked).toEqual([
        { sellerId: r.current().state.sellerId, productId: r.current().state.productId },
      ]);
    });

    it('holds a watched change of a product in an always-review category (R7, slice 4)', async () => {
      const r = rig({ facts: { sensitiveCategory: true } });
      const held = await r.edit.execute(sellerContext(), form(r, 'Clean text'));
      expect(held.ok && held.value).toMatchObject({
        applied: false,
        reasons: ['held-for-review'],
      });
      const [change] = r.changes();
      expect(change?.reasons).toEqual(['sensitive-category']);
      // R7 never holds a field the rules do not watch, and mode off holds nothing but a stop.
      const sku = rig({ facts: { sensitiveCategory: true } });
      const applied = await sku.edit.execute(
        sellerContext(),
        form(sku, 'Lamb shoulder, 1 kg', { sellerSku: 'SKU-9' }),
      );
      expect(applied.ok && applied.value).toMatchObject({ applied: true });
      const off = rig({ settings: OFF, facts: { sensitiveCategory: true } });
      const offEdit = await off.edit.execute(sellerContext(), form(off, 'Clean text'));
      expect(offEdit.ok && offEdit.value).toMatchObject({ applied: true });
    });

    it('never holds an edit for probation or full review (R1, R6 judge first publications)', async () => {
      const r = rig({ facts: { probation: true, fullReview: true } });
      const outcome = await r.edit.execute(sellerContext(), form(r, 'Clean text'));
      expect(outcome.ok && outcome.value).toMatchObject({ applied: true });
    });

    it('judges the edit in mode all when the facts are degraded, with no invented stop', async () => {
      const r = rig({ settings: OFF, facts: { degraded: true } });
      const outcome = await r.edit.execute(sellerContext(), form(r, 'Clean text'));
      expect(outcome.ok && outcome.value).toMatchObject({
        applied: false,
        reasons: ['held-for-review'],
      });
      const failed = rig({ settings: OFF, facts: 'fail' });
      const held = await failed.edit.execute(sellerContext(), form(failed, 'Clean text'));
      expect(held.ok && held.value).toMatchObject({
        applied: false,
        reasons: ['held-for-review'],
      });
    });

    it('fails closed: a settings read that fails holds the change (mode all)', async () => {
      const r = rig({ settings: 'fail' });
      const outcome = await r.edit.execute(sellerContext(), form(r, 'Clean text'));
      expect(outcome.ok && outcome.value).toMatchObject({
        applied: false,
        reasons: ['held-for-review'],
      });
    });

    it('never reads the settings for a non-watched edit or a draft Offer', async () => {
      const r = rig();
      await r.edit.execute(sellerContext(), form(r, 'Lamb shoulder, 1 kg', { sellerSku: 'SKU-9' }));
      const draft = rig({
        offer: liveOffer({
          status: 'draft',
          listed: false,
          firstPublishedAt: null,
          submittedAt: null,
        }),
      });
      const edited = await draft.edit.execute(sellerContext(), form(draft, CONTACT));
      expect(edited.ok && edited.value).toEqual({ changedFields: ['description'], applied: true });
      expect(r.settingsReads() + draft.settingsReads()).toBe(0);
      expect([...r.referrals, ...draft.referrals]).toEqual([]);
    });

    it('refuses claim text before the policy; nothing is held', async () => {
      const r = rig();
      const outcome = await r.edit.execute(sellerContext(), form(r, 'certified halal lamb'));
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.error.code).toBe('claim-text.refused');
      expect(r.changes()).toEqual([]);
    });

    it('refuses a watched edit while a change is pending, applies a non-watched one', async () => {
      const r = rig();
      await r.edit.execute(sellerContext(), form(r, CONTACT));
      expect(await r.edit.execute(sellerContext(), form(r, 'Another text'))).toEqual({
        ok: false,
        error: { code: 'offer.change-pending' },
      });
      expect(
        await r.setHandling.execute(sellerContext(), { offerId: r.offerId, handling: 'FRESH' }),
      ).toEqual({ ok: false, error: { code: 'offer.change-pending' } });
      const sku = await r.edit.execute(
        sellerContext(),
        form(r, 'Lamb shoulder, 1 kg', { sellerSku: 'SKU-7' }),
      );
      expect(sku).toEqual({ ok: true, value: { changedFields: ['sellerSku'], applied: true } });
      expect(r.current().state.sellerSku).toBe('SKU-7');
      expect(r.changes().filter((c) => c.status === 'pending')).toHaveLength(1);
    });

    it('replacePending supersedes the open change and judges the new edit alone', async () => {
      const r = rig();
      await r.edit.execute(sellerContext(), form(r, CONTACT));
      const [first] = r.changes();
      const outcome = await r.edit.execute(
        sellerContext(),
        form(r, 'A clean rewrite', { replacePending: true }),
      );
      expect(outcome).toEqual({
        ok: true,
        value: { changedFields: ['description'], applied: true },
      });
      expect(r.changes().find((c) => c.id === first!.id)).toMatchObject({
        status: 'superseded',
        supersededCause: 'resubmitted',
        decidedByAccountId: null,
      });
      expect(r.current().state.description).toEqual({ [locale]: 'A clean rewrite' });
      expect(r.audits()).toContain('catalog.offer-change.superseded');
      expect(
        await r.edit.execute(sellerContext(), form(r, 'x', { replacePending: 'yes' })),
      ).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'replacePending', code: 'type' }] },
      });
    });
  });

  describe('own-offer.set-handling', () => {
    it('holds a change away from SEALED_ORIGINAL (R3), changing nothing but the version', async () => {
      const r = rig();
      const outcome = await r.setHandling.execute(sellerContext(), {
        offerId: r.offerId,
        handling: 'REPACKED',
      });
      expect(outcome.ok && outcome.value).toMatchObject({
        changedFields: [],
        applied: false,
        reasons: ['handling'],
      });
      expect(r.current().state).toMatchObject({ handling: 'SEALED_ORIGINAL', version: 5 });
      expect(r.changes()[0]).toMatchObject({
        proposedHandling: 'REPACKED',
        proposedDescription: null,
      });
      expect(r.evaluator.calls).toHaveLength(0);
    });

    it('tells the seller held-for-review for a seller stop, keeping handling (Hassan S1)', async () => {
      const r = rig({ facts: { emergencyStop: true } });
      const outcome = await r.setHandling.execute(sellerContext(), {
        offerId: r.offerId,
        handling: 'REPACKED',
      });
      expect(outcome.ok && outcome.value).toMatchObject({
        applied: false,
        reasons: ['handling', 'held-for-review'],
      });
      expect(r.changes()[0]?.reasons).toEqual(['emergency-stop', 'handling']);
    });

    it('applies a move to SEALED_ORIGINAL at once in risk-based mode', async () => {
      const r = rig({ offer: liveOffer({ handling: 'FRESH' }) });
      const outcome = await r.setHandling.execute(sellerContext(), {
        offerId: r.offerId,
        handling: 'SEALED_ORIGINAL',
      });
      expect(outcome).toEqual({ ok: true, value: { changedFields: ['handling'], applied: true } });
      expect(r.referrals).toEqual([expect.objectContaining({ trigger: 'edit', reasons: [] })]);
    });
  });

  describe('own-offer.add-tag', () => {
    it('holds a new badge while badges are reviewed (R2), writing no tag', async () => {
      const r = rig();
      const outcome = await r.addTag.execute(sellerContext(), { offerId: r.offerId, typeCode });
      if (!outcome.ok) throw new Error(outcome.error.code);
      expect(outcome.value).toMatchObject({
        typeCode,
        status: 'held',
        basis: null,
        applied: false,
        reasons: ['certificate-badge'],
      });
      expect(r.current().tags).toEqual([]);
      expect(r.changes()[0]).toMatchObject({ proposedTagTypes: [typeCode] });
      expect(r.outbox.appended).toEqual([]);
    });

    it('tells the seller held-for-review for an always-review category (Hassan S1)', async () => {
      const r = rig({ facts: { sensitiveCategory: true } });
      const outcome = await r.addTag.execute(sellerContext(), { offerId: r.offerId, typeCode });
      if (!outcome.ok) throw new Error(outcome.error.code);
      expect(outcome.value).toMatchObject({
        applied: false,
        reasons: ['certificate-badge', 'held-for-review'],
      });
      expect(r.changes()[0]?.reasons).toEqual(['certificate-badge', 'sensitive-category']);
    });

    it('refuses a type certification does not allow, never queueing it', async () => {
      const r = rig();
      const outcome = await r.addTag.execute(sellerContext(), {
        offerId: r.offerId,
        typeCode: REFUSED_TYPE,
      });
      expect(outcome).toEqual({
        ok: false,
        error: {
          code: 'claim.tag-not-allowed',
          tags: [{ typeCode: REFUSED_TYPE, reason: 'no-certificate' }],
        },
      });
      expect(r.changes()).toEqual([]);
    });

    it('adds at once when badges are automatic in risk-based mode', async () => {
      const r = rig({ settings: { ...RISK, certificateBadges: 'automatic' } });
      const outcome = await r.addTag.execute(sellerContext(), { offerId: r.offerId, typeCode });
      expect(outcome).toEqual({
        ok: true,
        value: { typeCode, status: 'active', basis: 'SELLER', applied: true },
      });
    });
  });

  describe('own-offer.withdraw-change and delete', () => {
    it('withdraws the open change; the live Offer stays', async () => {
      const r = rig();
      await r.edit.execute(sellerContext(), form(r, CONTACT));
      const outcome = await r.withdraw.execute(sellerContext(), { offerId: r.offerId });
      expect(outcome.ok && outcome.value).toMatchObject({ status: 'withdrawn' });
      expect(r.changes()[0]).toMatchObject({ status: 'withdrawn', decisionNote: null });
      expect(r.current().state.version).toBe(6);
      expect(await r.withdraw.execute(sellerContext(), { offerId: r.offerId })).toEqual({
        ok: false,
        error: { code: 'offer-change.not-found' },
      });
    });

    it('answers offer-change.not-found for another seller', async () => {
      const r = rig();
      await r.edit.execute(sellerContext(), form(r, CONTACT));
      expect(
        await r.withdraw.execute(sellerContext(ids.next<'Seller'>()), { offerId: r.offerId }),
      ).toEqual({ ok: false, error: { code: 'offer-change.not-found' } });
      expect(r.changes()[0]!.status).toBe('pending');
    });

    it('supersedes the open change when the Offer is deleted, in the same unit', async () => {
      const r = rig();
      await r.edit.execute(sellerContext(), form(r, CONTACT));
      expect((await r.remove.execute(sellerContext(), { offerId: r.offerId })).ok).toBe(true);
      expect(r.current().state.status).toBe('deleted');
      expect(r.changes()[0]).toMatchObject({
        status: 'superseded',
        supersededCause: 'offer-deleted',
      });
    });
  });

  describe('admin decisions', () => {
    const heldEdit = async (r: ReturnType<typeof rig>) => {
      const outcome = await r.edit.execute(sellerContext(), form(r, CONTACT));
      if (!outcome.ok || outcome.value.pendingChangeId === undefined) throw new Error('not held');
      return outcome.value.pendingChangeId;
    };

    it('lists the pending changes oldest first, keyset-paged', async () => {
      const a = rig();
      const changeId = await heldEdit(a);
      const page = await a.list.execute(adminContext(), { limit: 1 });
      expect(page.ok && page.value.items.map((i) => i.changeId)).toEqual([changeId]);
      expect(page.ok && page.value.items[0]).toMatchObject({
        fields: ['description'],
        reasons: ['contact-text'],
        sellerId,
        // The live values next to the proposed ones (slice 5): the held text is not live.
        live: { description: { [locale]: 'Lamb shoulder, 1 kg' }, handling: 'SEALED_ORIGINAL' },
        offer: { status: 'published', sellerSku: 'SKU-1' },
        product: { productCode: 'P1', name: 'Lamb' },
      });
      expect(page.ok && page.value.nextAfterId).toBeNull();
      expect(await a.list.execute(sellerContext(), {})).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it('approves a held description: it goes live in one unit, once', async () => {
      const r = rig();
      const changeId = await heldEdit(r);
      const outcome = await r.approve.execute(adminContext(), { changeId });
      expect(outcome).toEqual({
        ok: true,
        value: { changeId, offerId: r.offerId, status: 'approved', fields: ['description'] },
      });
      expect(r.current().state).toMatchObject({ description: { [locale]: CONTACT }, version: 6 });
      expect(r.changes()[0]).toMatchObject({ status: 'approved' });
      expect(r.audits()).toContain('catalog.offer-change.approved');
      expect(await r.approve.execute(adminContext(), { changeId })).toEqual({
        ok: false,
        error: { code: 'offer-change.not-pending' },
      });
    });

    it('approves held handling and badge: attestation cleared, tag asked afresh and active', async () => {
      const r = rig({
        settings: ALL,
        offer: liveOffer({
          attestationRecordedAt: T0,
          attestationAccountId: ids.next<'Account'>(),
        }),
      });
      await r.setHandling.execute(sellerContext(), { offerId: r.offerId, handling: 'REPACKED' });
      const [handlingChange] = r.changes();
      expect((await r.approve.execute(adminContext(), { changeId: handlingChange!.id })).ok).toBe(
        true,
      );
      expect(r.current().state).toMatchObject({
        handling: 'REPACKED',
        attestationRecordedAt: null,
      });
      const tag = await r.addTag.execute(sellerContext(), { offerId: r.offerId, typeCode });
      if (!tag.ok || tag.value.pendingChangeId === undefined) throw new Error('not held');
      const asked = r.evaluator.calls.length;
      const approved = await r.approve.execute(adminContext(), {
        changeId: tag.value.pendingChangeId,
        note: 'Certificate checked',
      });
      expect(approved.ok).toBe(true);
      expect(r.evaluator.calls.length).toBeGreaterThan(asked);
      expect(r.current().tags).toEqual([expect.objectContaining({ typeCode, status: 'active' })]);
      expect(r.outbox.types).toContain('catalog.offer-tag-added.v1');
    });

    it('fails the whole approval when a requested type is no longer allowed: nothing applied', async () => {
      const r = rig({ settings: ALL });
      await r.addTag.execute(sellerContext(), { offerId: r.offerId, typeCode });
      const [held] = r.changes();
      // Certification no longer allows the type by the time the admin decides.
      r.evaluator.decide = (query) => refusedDecision(query, 'certificate-expired');
      const before = r.current();
      const outcome = await r.approve.execute(adminContext(), { changeId: held!.id });
      expect(outcome).toEqual({
        ok: false,
        error: {
          code: 'claim.tag-not-allowed',
          tags: [{ typeCode, reason: 'certificate-expired' }],
        },
      });
      expect(r.current()).toBe(before);
      expect(r.changes()[0]!.status).toBe('pending');
    });

    it('requests changes or rejects with a required note; the live Offer stays', async () => {
      const r = rig();
      const changeId = await heldEdit(r);
      expect(await r.requestChanges.execute(adminContext(), { changeId, note: ' ' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'note', code: 'length' }] },
      });
      expect(await r.reject.execute(adminContext(), { changeId } as never)).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'note', code: 'required' }] },
      });
      const sent = await r.requestChanges.execute(adminContext(), {
        changeId,
        note: 'Please remove the phone number',
      });
      expect(sent.ok && sent.value.status).toBe('changes-requested');
      expect(r.changes()[0]).toMatchObject({ decisionNote: 'Please remove the phone number' });
      expect(r.current().state.description).toEqual({ [locale]: 'Lamb shoulder, 1 kg' });
      // A new edit after the decision is judged again.
      const again = await r.edit.execute(sellerContext(), form(r, 'Clean now'));
      expect(again.ok && again.value.applied).toBe(true);

      const other = rig();
      const otherId = await heldEdit(other);
      const rejected = await other.reject.execute(adminContext(), {
        changeId: otherId,
        note: 'No',
      });
      expect(rejected.ok && rejected.value.status).toBe('rejected');
      expect(other.audits()).toContain('catalog.offer-change.rejected');
    });

    it('refuses the approval when the held description now hits the claim vocabulary (S2a)', async () => {
      const r = rig();
      const changeId = await heldEdit(r);
      // The vocabulary grew between the hold and the decision.
      r.claimWords.push('bulk');
      const before = r.current();
      const outcome = await r.approve.execute(adminContext(), { changeId });
      expect(outcome.ok === false && outcome.error.code).toBe('claim-text.refused');
      expect(r.current()).toBe(before);
      expect(r.changes()[0]).toMatchObject({ status: 'pending', decidedAt: null });
      expect(r.audits()).not.toContain('catalog.offer-change.approved');
    });

    it('applies nothing while certification cannot answer; the change stays pending (S2b)', async () => {
      // A kept tag is asked again against the held handling at approval.
      const r = rig({
        settings: ALL,
        tags: [activeTagState(ids.next<'OfferTag'>(), typeCode, certificate, T0)],
      });
      await r.setHandling.execute(sellerContext(), { offerId: r.offerId, handling: 'REPACKED' });
      const [held] = r.changes();
      r.evaluator.unavailable = true;
      const before = r.current();
      expect(await r.approve.execute(adminContext(), { changeId: held!.id })).toEqual({
        ok: false,
        error: { code: 'claim.check-unavailable' },
      });
      expect(r.current()).toBe(before);
      expect(r.current().state.handling).toBe('SEALED_ORIGINAL');
      expect(r.changes()[0]).toMatchObject({ status: 'pending', decidedAt: null });
      expect(r.audits()).not.toContain('catalog.offer-change.approved');
      // Certification answers again: the same change can be approved.
      r.evaluator.unavailable = false;
      expect((await r.approve.execute(adminContext(), { changeId: held!.id })).ok).toBe(true);
      expect(r.current().state.handling).toBe('REPACKED');
    });

    it('refuses to approve when the Offer is no longer published, applying nothing (G3)', async () => {
      const r = rig();
      const changeId = await heldEdit(r);
      r.force({ status: 'deleted', listed: false, deletedAt: T0 });
      const before = r.current();
      expect(await r.approve.execute(adminContext(), { changeId })).toEqual({
        ok: false,
        error: { code: 'offer-change.not-pending' },
      });
      expect(r.current()).toBe(before);
      expect(r.changes()[0]).toMatchObject({ status: 'pending' });
    });

    it('answers offer-change.invalid for a stored value the Offer refuses, applying nothing (N2)', async () => {
      const r = rig();
      // A stored change whose description the Offer refuses (one locale over the limit).
      r.store({
        id: ids.next<'OfferPendingChange'>(),
        marketId: code as MarketId,
        offerId: r.offerId,
        sellerId,
        baseOfferVersion: 4,
        proposedDescription: { [locale]: 'x'.repeat(5001) },
        proposedHandling: null,
        proposedTagTypes: [],
        reasons: ['review-all'],
        policyVersion: 2,
        status: 'pending',
        supersededCause: null,
        submittedAt: T0,
        submittedByAccountId: ids.next<'Account'>(),
        decidedAt: null,
        decidedByAccountId: null,
        decisionNote: null,
      });
      const [stored] = r.changes();
      const before = r.current();
      expect(await r.approve.execute(adminContext(), { changeId: stored!.id })).toEqual({
        ok: false,
        error: { code: 'offer-change.invalid' },
      });
      expect(r.current()).toBe(before);
      expect(r.changes()[0]).toMatchObject({ status: 'pending' });
    });

    it('never lets an admin decide a change their own account made (N3)', async () => {
      const r = rig();
      const admin = ids.next<'Account'>();
      const made = await r.edit.execute(sellerContext(sellerId, admin), form(r, CONTACT));
      if (!made.ok || made.value.pendingChangeId === undefined) throw new Error('not held');
      const changeId = made.value.pendingChangeId;
      const own = { ok: false, error: { code: 'offer-change.own-submission' } };
      expect(await r.approve.execute(adminContext(admin), { changeId })).toEqual(own);
      expect(await r.reject.execute(adminContext(admin), { changeId, note: 'No' })).toEqual(own);
      expect(
        await r.requestChanges.execute(adminContext(admin), { changeId, note: 'Fix it' }),
      ).toEqual(own);
      expect(r.changes()[0]).toMatchObject({ status: 'pending' });
      // Another admin decides it.
      expect((await r.approve.execute(adminContext(), { changeId })).ok).toBe(true);
    });

    it('records the admin behind a Login-as-Seller edit as the submitter of the held change (N3)', async () => {
      // No session carries the reserved marker yet (SEL-08), so the gate cannot mint one: the
      // review step is called directly with the marker an acting-as session will carry.
      const memory = memoryOfferEditReview({ ids });
      const admin = ids.next<'Account'>();
      const seller = sellerContext();
      const acting = {
        ...seller,
        actor: { ...seller.actor, actingAs: { adminAccountId: admin } },
      } as unknown as CallContext;
      const changeId = await memory.review.settle(acting, {
        offer: Offer.restore(liveOffer()),
        baseVersion: 4,
        reasons: ['contact-text'],
        change: { addedBadgeTypes: [], newDescription: { [locale]: CONTACT } },
        replaced: null,
        now: T0,
      });
      expect(changeId).not.toBeNull();
      expect(memory.pendingChanges.rows.get(changeId!)).toMatchObject({
        submittedByAccountId: admin,
      });
    });

    it("refuses a decision from a Login-as-Seller session for the change's seller (N3)", async () => {
      const r = rig();
      await heldEdit(r);
      const [held] = r.changes();
      const own = { ok: false, error: { code: 'offer-change.own-submission' } };
      // The gate cannot mint the reserved marker yet (SEL-08): the shared decision step and the
      // guard the approval runs first are called directly.
      for (const acting of [
        { accountId: ids.next<'Account'>(), sellerId },
        { accountId: ids.next<'Account'>(), sellerId: null },
      ]) {
        const context = actingAdmin(acting);
        expect(decidesOwnSubmission(context.actor, held!)).toBe(true);
        for (const decision of [
          { kind: 'reject', note: 'No' },
          { kind: 'request-changes', note: 'Fix' },
        ] as const) {
          expect(await r.decide(context, { changeId: held!.id }, decision)).toEqual(own);
        }
      }
      expect(r.changes()[0]).toMatchObject({ status: 'pending' });
      // Acting for another seller is not acting for this one; a plain admin is not the submitter.
      const elsewhere = actingAdmin({ accountId: ids.next<'Account'>(), sellerId: ids.next() });
      expect(decidesOwnSubmission(elsewhere.actor, held!)).toBe(false);
      expect(decidesOwnSubmission(adminContext().actor, held!)).toBe(false);
      expect(
        await r.decide(elsewhere, { changeId: held!.id }, { kind: 'reject', note: 'No' }),
      ).toMatchObject({ ok: true, value: { status: 'rejected' } });
    });

    it('audits the held handling and the approved handling and tag ids, never text (N1)', async () => {
      const r = rig({ settings: ALL });
      await r.setHandling.execute(sellerContext(), { offerId: r.offerId, handling: 'REPACKED' });
      const [handlingChange] = r.changes();
      expect((await r.approve.execute(adminContext(), { changeId: handlingChange!.id })).ok).toBe(
        true,
      );
      const tag = await r.addTag.execute(sellerContext(), { offerId: r.offerId, typeCode });
      if (!tag.ok || tag.value.pendingChangeId === undefined) throw new Error('not held');
      expect(
        (
          await r.approve.execute(adminContext(), {
            changeId: tag.value.pendingChangeId,
            note: 'Never in the audit',
          })
        ).ok,
      ).toBe(true);
      const of = (action: string) =>
        r
          .auditEntries()
          .filter((entry) => entry.action === action)
          .map((entry) => entry.after);
      expect(of('catalog.offer-change.held')).toEqual([
        {
          changeId: handlingChange!.id,
          fields: ['handling'],
          handling: 'repacked',
          reasons: ['handling'],
          policyVersion: 4,
        },
        {
          changeId: tag.value.pendingChangeId,
          fields: ['tags'],
          handling: null,
          reasons: ['review-all'],
          policyVersion: 4,
        },
      ]);
      const tagId = r.current().tags.find((t) => t.typeCode === typeCode)!.id;
      expect(of('catalog.offer-change.approved')).toEqual([
        {
          changeId: handlingChange!.id,
          fields: ['handling'],
          handling: 'repacked',
          addedTagIds: [],
        },
        {
          changeId: tag.value.pendingChangeId,
          fields: ['tags'],
          handling: null,
          addedTagIds: [tagId],
        },
      ]);
      expect(JSON.stringify(r.auditEntries())).not.toContain('Never in the audit');
    });

    it('never reaches a change from the other Market: approve, reject, withdraw, list (canary)', async () => {
      const r = rig();
      const changeId = await heldEdit(r);
      const before = r.current();
      const notFound = { ok: false, error: { code: 'offer-change.not-found' } };
      const otherAdmin = () => adminContext(ids.next<'Account'>(), otherMarket);
      expect(await r.approve.execute(otherAdmin(), { changeId })).toEqual(notFound);
      expect(await r.reject.execute(otherAdmin(), { changeId, note: 'Canary' })).toEqual(notFound);
      expect(await r.requestChanges.execute(otherAdmin(), { changeId, note: 'Canary' })).toEqual(
        notFound,
      );
      expect(
        await r.withdraw.execute(sellerContext(sellerId, ids.next<'Account'>(), otherMarket), {
          offerId: r.offerId,
        }),
      ).toEqual(notFound);
      const listed = await r.list.execute(otherAdmin(), {});
      expect(listed.ok && listed.value.items).toEqual([]);
      expect(r.current()).toBe(before);
      expect(r.changes()[0]).toMatchObject({ status: 'pending' });
    });

    it('refuses a seller on the admin decisions', async () => {
      const r = rig();
      const changeId = await heldEdit(r);
      for (const useCase of [r.approve, r.reject, r.requestChanges] as const) {
        expect(
          await (useCase as AdminOfferChangeReject).execute(sellerContext(), {
            changeId,
            note: 'x',
          }),
        ).toEqual({ ok: false, error: { code: 'access.denied' } });
      }
    });

    it('answers offer-change.not-found for an unknown change', async () => {
      const r = rig();
      expect(
        await r.approve.execute(adminContext(), { changeId: ids.next<'OfferPendingChange'>() }),
      ).toEqual({ ok: false, error: { code: 'offer-change.not-found' } });
    });
  });

  it('keeps tags it already had through a held edit (activeTagState fixture)', async () => {
    const offer = liveOffer();
    const r = rig({
      offer,
      tags: [activeTagState(ids.next<'OfferTag'>(), typeCode, certificate, T0)],
    });
    const outcome = await r.edit.execute(sellerContext(), form(r, CONTACT));
    expect(outcome.ok && outcome.value.applied).toBe(false);
    expect(r.current().tags).toEqual([expect.objectContaining({ typeCode, status: 'active' })]);
  });
});
