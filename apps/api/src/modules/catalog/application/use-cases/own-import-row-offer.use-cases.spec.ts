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
  FakeClaimEvaluator,
  FixedFactsClaimQueryBuilder,
  RecordingOutbox,
  activeTagState,
  allowedDecision,
  refusedDecision,
} from '../../../../../test/support/catalog-tag-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { Offer, type OfferState } from '../../domain/offer';
import type { ClaimFacts } from '../../domain/offer-tag';
import { Product, type ProductState } from '../../domain/product';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import { CheckClaimText } from '../claim-text/check-claim-text.service';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import { OwnImportRowOfferCreate } from './own-import-row-offer-create.use-case';
import { OwnImportRowOfferEdit } from './own-import-row-offer-edit.use-case';
import { OwnOfferCreateOnPlatformProduct } from './own-offer-create-on-platform-product.use-case';
import { OwnOfferEdit } from './own-offer-edit.use-case';

// The Offer rows of the seller import (catalog design 14c), in memory on both Market fixtures with
// the REAL claim-text check over a matcher: a claim in an Offer description fails the row and
// stores nothing (ADR-0031 d2a, import row), and a row's Offer edit that makes a kept tag no
// longer allowed suspends it under the `import-row` entry path (the tag's cause), takes the Offer
// off sale and emits the same events as the form. The interactive save budget is not spent.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-07T00:00:00Z');
const CLAIM = 'certified halal cure';

describe.each(['AU', 'ZZ'] as const)('seller import Offer rows in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const locale = policy.locales(market).default;
  const condition = policy.conditions(market)[0]!;
  const sellerId = ids.next<'Seller'>();
  const context: CallContext = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId,
    }),
  );
  const unitOfWork = {
    run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
  } as unknown as UnitOfWork;
  const matched: string[] = [];
  const matcher: ClaimTextMatcher = {
    match: (_c, texts) => {
      matched.push(...texts.map((item) => item.text));
      return Promise.resolve({
        ok: true as const,
        value: texts.map((item) =>
          item.text.includes('halal') ? [{ typeCode: 'halal', start: 0, end: 5 }] : [],
        ),
      });
    },
  } as unknown as ClaimTextMatcher;
  // The real check, spending no limit (the counters are never reached by an internal caller).
  const check = new CheckClaimText({
    unitOfWork,
    matcher,
    counters: {
      reserve: () => Promise.reject(new Error('a row spends no claim-text budget')),
      purgeStartedBefore: () => Promise.resolve(0),
    },
    counterKeys: { keyOf: () => 'k' } as never,
    policy,
    clock,
  });
  // The row use cases are built with a save budget that never answers a refusal (the module wires
  // `NO_SAVE_BUDGET`): the interactive limit is not spent by a row.
  const noBudget = { reserveSaves: (): Promise<null> => Promise.resolve(null) };
  beforeEach(() => {
    matched.length = 0;
  });

  const productState = (): ProductState => ({
    id: ids.next<'Product'>(),
    marketId: code as MarketId,
    scope: 'PLATFORM',
    ownerSellerId: null,
    createdBySellerId: null,
    typeCode: 'simple',
    variantModel: 'single',
    familyCode: 'default',
    productCode: 'P00000001',
    status: 'published',
    discardedAt: null,
    withdrawnAt: null,
    retiredAt: null,
    pausedAt: null,
    pausedByAccountId: null,
    ownBrand: false,
    lastChangedAt: T0,
    version: 3,
    createdAt: T0,
    publishedRevisionId: ids.next<'ProductRevision'>(),
    pendingRevisionId: null,
    pendingSubmittedAt: null,
    variants: [],
  });

  describe('own-import.row-offer-create', () => {
    function createRig() {
      const state = productState();
      const stored: Offer[] = [];
      const inner = new OwnOfferCreateOnPlatformProduct(gate, {
        unitOfWork,
        products: {
          lockAtVersion: () => Promise.resolve(true),
          nextProductCode: () => Promise.reject(new Error('unused')),
          add: () => Promise.reject(new Error('unused')),
          findById: () => Promise.resolve(Product.restore(state)),
          save: () => Promise.reject(new Error('unused')),
        },
        offers: {
          add: (_m, offer) => {
            stored.push(offer);
            return Promise.resolve(null);
          },
          findById: () => Promise.resolve(null),
          listOnProduct: () => Promise.resolve([]),
          listPendingReview: () => Promise.resolve([]),
          findManyByIds: () => Promise.resolve([]),
          save: () => Promise.reject(new Error('unused')),
        },
        eligibility: { isEligible: () => Promise.resolve(true) },
        allowedTypes: { allowedFor: () => Promise.resolve('all') },
        check,
        save: noBudget,
        policy,
        outbox: new RecordingOutbox(),
        clock,
        ids,
      } as never);
      const useCase = new OwnImportRowOfferCreate(gate, { create: inner });
      return { useCase, state, stored };
    }

    it('fails the row and stores no Offer when the description holds a claim', async () => {
      const r = createRig();
      const outcome = await r.useCase.execute(context, {
        productId: r.state.id,
        sellerSku: 'SKU-1',
        conditionCode: condition,
        description: { [locale]: CLAIM },
      });
      expect(outcome).toMatchObject({ ok: false, error: { code: 'claim-text.refused' } });
      expect(r.stored).toHaveLength(0);
      expect(matched).toEqual([CLAIM]);
    });

    it('creates the Offer for a clean description', async () => {
      const r = createRig();
      const outcome = await r.useCase.execute(context, {
        productId: r.state.id,
        sellerSku: 'SKU-1',
        conditionCode: condition,
        description: { [locale]: 'A tidy listing' },
      });
      expect(outcome.ok).toBe(true);
      expect(r.stored).toHaveLength(1);
      expect(r.stored[0]!.state).toMatchObject({ status: 'draft', handling: null, listed: false });
    });

    it('refuses a caller that is not a seller before anything is read', async () => {
      const r = createRig();
      const admin = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
      );
      expect(
        await r.useCase.execute(admin, {
          productId: r.state.id,
          sellerSku: 'SKU-1',
          conditionCode: condition,
          description: {},
        }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
    });
  });

  describe('own-import.row-offer-edit', () => {
    const typeCode = code === 'AU' ? 'halal' : 'zz-cert';
    const variantIds = [ids.next<'Variant'>()];
    const certificateIds = {
      certificateId: ids.next(),
      versionId: ids.next(),
      typeRevisionId: ids.next(),
    };
    const offerState = (over: Partial<OfferState> = {}): OfferState => ({
      id: ids.next<'Offer'>(),
      marketId: code as MarketId,
      sellerId,
      productId: ids.next<'Product'>(),
      sellerSku: 'SKU-1',
      conditionCode: condition,
      description: { [locale]: 'A tidy listing' },
      handling: 'SEALED_ORIGINAL',
      attestationRecordedAt: null,
      attestationAccountId: null,
      status: 'published',
      offSaleCauses: [],
      listed: true,
      submittedAt: T0,
      firstPublishedAt: T0,
      deletedAt: null,
      version: 2,
      createdAt: T0,
      ...over,
    });
    const factsOf = (state: OfferState): ClaimFacts => ({
      productId: state.productId,
      productRevisionId: ids.next<'ProductRevision'>(),
      revisionPublished: true,
      variantIds,
      platformCategoryPaths: [[ids.next<'Category'>()]],
    });

    function editRig(refuse?: string) {
      const state = offerState();
      const saved: Offer[] = [];
      const outbox = new RecordingOutbox();
      const evaluator = new FakeClaimEvaluator(
        (query) =>
          refuse !== undefined
            ? refusedDecision(query, refuse)
            : allowedDecision(query, certificateIds),
        [typeCode],
      );
      const inner = new OwnOfferEdit(
        gate,
        {
          unitOfWork,
          offers: {
            add: () => Promise.reject(new Error('unused')),
            listOnProduct: () => Promise.resolve([]),
            listPendingReview: () => Promise.resolve([]),
            findManyByIds: () => Promise.resolve([]),
            findById: () =>
              Promise.resolve(
                Offer.restore(state, [
                  activeTagState(ids.next<'OfferTag'>(), typeCode, certificateIds, T0),
                ]),
              ),
            save: (_m, offer) => {
              saved.push(offer);
              return Promise.resolve(null);
            },
          },
          eligibility: { isEligible: () => Promise.resolve(true) },
          check,
          save: noBudget,
          policy,
          claims: new FixedFactsClaimQueryBuilder(factsOf(state)),
          evaluator,
          outbox,
          clock,
        } as never,
        'import-row',
      );
      const useCase = new OwnImportRowOfferEdit(gate, { edit: inner });
      return { useCase, state, saved, outbox, evaluator };
    }
    const form = (offerId: Id<'Offer'>, description: string) => ({
      offerId,
      sellerSku: 'SKU-1',
      conditionCode: condition,
      description: { [locale]: description },
    });

    it('suspends a kept tag that is no longer allowed under the import-row entry path', async () => {
      const r = editRig('certificate-expired');
      const outcome = await r.useCase.execute(context, form(r.state.id, 'A new listing text'));
      expect(outcome.ok).toBe(true);
      const tag = r.saved[0]!.tags[0]!;
      expect(tag).toMatchObject({
        status: 'suspended',
        badge: null,
        lastReasonCode: 'certificate-expired',
        lastChangeCause: 'import-row',
      });
      expect(r.saved[0]!.state.listed).toBe(false);
      expect(r.outbox.types).toEqual([
        'catalog.offer-tag-suspended.v1',
        'catalog.offer-listing-changed.v1',
      ]);
    });

    it('keeps an allowed tag active and asks again once for the variants', async () => {
      const r = editRig();
      const outcome = await r.useCase.execute(context, form(r.state.id, 'A new listing text'));
      expect(outcome.ok).toBe(true);
      expect(r.evaluator.calls).toHaveLength(1);
      expect(r.saved[0]!.tags[0]).toMatchObject({ typeCode, status: 'active' });
      expect(r.outbox.types).toEqual([]);
    });

    it('fails the row with the claim-text refusal and saves nothing when the description holds a claim', async () => {
      const r = editRig();
      const outcome = await r.useCase.execute(context, form(r.state.id, CLAIM));
      expect(outcome).toMatchObject({ ok: false, error: { code: 'claim-text.refused' } });
      expect(r.saved).toHaveLength(0);
      expect(r.evaluator.calls).toHaveLength(0);
    });
  });
});
