import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, MarketId, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { Offer } from '../../domain/offer';
import { Product, type ProductState } from '../../domain/product';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { CheckClaimText, ClaimTextVerdict } from '../claim-text/check-claim-text.service';
import type { AllowedProductTypes } from '../ports/allowed-product-types.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferAddRefusal } from '../ports/offer.repository';
import { OwnOfferCreateOnPlatformProduct } from './own-offer-create-on-platform-product.use-case';

// `own-offer.create-on-platform-product` in memory (catalog design 4.4 first row; slice 7a-2), on
// both Market fixtures with the Market's real configuration. The gate admits every authenticated
// actor; the access declaration is checked by the CI list. The database behaviour is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const realPolicy = new ConfigCatalogMarketPolicy(markets);
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-09T00:00:00Z');

describe.each(['AU', 'ZZ'] as const)(
  'own-offer.create-on-platform-product in market %s',
  (code) => {
    const market: MarketContext = testMarketContext(code, 'default');
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const locale = realPolicy.locales(market).default;
    const condition = realPolicy.conditions(market)[0]!;
    const sellerId = ids.next<'Seller'>();

    const contextOf = (population: 'admin' | 'seller' | 'customer'): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population,
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: population === 'seller' ? sellerId : null,
        }),
      );

    function productState(overrides: Partial<ProductState> = {}): ProductState {
      return {
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
        ownBrand: false,
        lastChangedAt: T0,
        version: 3,
        createdAt: T0,
        publishedRevisionId: ids.next<'ProductRevision'>(),
        pendingRevisionId: null,
        pendingSubmittedAt: null,
        variants: [],
        ...overrides,
      };
    }

    function rig(
      options: {
        product?: ProductState | null;
        eligible?: boolean;
        allowed?: AllowedProductTypes | null;
        sellFromCatalogue?: boolean | 'fault';
        verdicts?: (texts: readonly { locale: string; text: string }[]) => ClaimTextVerdict[];
        addRefusal?: OfferAddRefusal;
      } = {},
    ) {
      const state = options.product === undefined ? productState() : options.product;
      const stored: Offer[] = [];
      const events: unknown[] = [];
      const checked: { locale: string; text: string }[][] = [];
      const unitOfWork = {
        run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
      } as unknown as UnitOfWork;
      const policy: CatalogMarketPolicy = Object.create(realPolicy) as CatalogMarketPolicy;
      policy.sellFromCatalogue = () =>
        options.sellFromCatalogue === 'fault'
          ? Promise.reject(new Error('down'))
          : Promise.resolve(options.sellFromCatalogue ?? true);
      const check = {
        execute: (_c: CallContext, texts: readonly { locale: string; text: string }[]) => {
          checked.push([...texts]);
          const verdicts =
            options.verdicts?.(texts) ??
            texts.map((item) => ({
              code: 'clean' as const,
              field: 'offer.description' as const,
              ref: null,
              locale: item.locale,
            }));
          return Promise.resolve({ ok: true as const, value: verdicts });
        },
      } as unknown as CheckClaimText;
      const outbox: OutboxWriter = {
        append: (_c, list) => {
          events.push(...list);
          return Promise.resolve();
        },
      };
      const useCase = new OwnOfferCreateOnPlatformProduct(gate, {
        unitOfWork,
        products: {
          nextProductCode: () => Promise.reject(new Error('unused')),
          add: () => Promise.reject(new Error('unused')),
          findById: () => Promise.resolve(state === null ? null : Product.restore(state)),
          save: () => Promise.reject(new Error('unused')),
        },
        offers: {
          add: (_m, offer) => {
            if (options.addRefusal !== undefined) return Promise.resolve(options.addRefusal);
            stored.push(offer);
            return Promise.resolve(null);
          },
          findById: () => Promise.resolve(null),
        },
        eligibility: { isEligible: () => Promise.resolve(options.eligible ?? true) },
        allowedTypes: {
          allowedFor: () =>
            Promise.resolve(options.allowed === undefined ? 'all' : options.allowed),
        },
        check,
        policy,
        outbox,
        clock,
        ids,
      });
      return { useCase, state, stored, events, checked };
    }

    const request = (productId: Id<'Product'>, extra: Record<string, unknown> = {}) => ({
      productId,
      sellerSku: 'SKU-1',
      conditionCode: condition,
      description: { [locale]: 'A tidy listing' },
      ...extra,
    });

    it('creates a draft Offer for the actor’s seller and records offer-created', async () => {
      const r = rig();
      const created = await r.useCase.execute(contextOf('seller'), request(r.state!.id));
      if (!created.ok) throw new Error(created.error.code);
      expect(r.stored).toHaveLength(1);
      expect(r.stored[0]!.state).toMatchObject({
        id: created.value.offerId,
        sellerId,
        productId: r.state!.id,
        status: 'draft',
        handling: null,
        attestationRecordedAt: null,
        listed: false,
        marketId: code,
      });
      expect(r.events).toHaveLength(1);
      expect(r.checked).toEqual([
        [{ field: 'offer.description', ref: null, locale, text: 'A tidy listing' }],
      ]);
    });

    it.each(['sellerId', 'handling', 'attestation', 'tags', 'status', 'scope'])(
      'refuses a request that names %s',
      async (key) => {
        const r = rig();
        const outcome = await r.useCase.execute(
          contextOf('seller'),
          request(r.state!.id, { [key]: 'x' }),
        );
        expect(outcome).toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: key, code: 'unknown' }] },
        });
        expect(r.stored).toHaveLength(0);
      },
    );

    it('refuses an admin and a customer', async () => {
      const r = rig();
      for (const population of ['admin', 'customer'] as const) {
        const outcome = await r.useCase.execute(contextOf(population), request(r.state!.id));
        expect(outcome).toEqual({ ok: false, error: { code: 'access.denied' } });
      }
      expect(r.stored).toHaveLength(0);
    });

    it('refuses a seller that may not sell', async () => {
      const r = rig({ eligible: false });
      const outcome = await r.useCase.execute(contextOf('seller'), request(r.state!.id));
      expect(outcome).toEqual({ ok: false, error: { code: 'seller.not-eligible' } });
    });

    it.each([
      [false, 'setting.sell-from-catalogue-off'],
      ['fault', 'access.unavailable'],
    ] as const)('answers %s of the sell-from-catalogue setting', async (value, expected) => {
      const r = rig({ sellFromCatalogue: value });
      const outcome = await r.useCase.execute(contextOf('seller'), request(r.state!.id));
      expect(outcome).toEqual({ ok: false, error: { code: expected } });
    });

    it('refuses a condition outside the Market list and a locale the Market does not support', async () => {
      const r = rig();
      const badCondition = await r.useCase.execute(
        contextOf('seller'),
        request(r.state!.id, { conditionCode: 'refurbished-x' }),
      );
      expect(badCondition).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'conditionCode', code: 'unknown' }] },
      });
      const badLocale = await r.useCase.execute(
        contextOf('seller'),
        request(r.state!.id, { description: { 'xx-XX': 'text' } }),
      );
      expect(badLocale).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'description', code: 'locale' }] },
      });
    });

    it('refuses a description over the bound', async () => {
      const r = rig();
      const outcome = await r.useCase.execute(
        contextOf('seller'),
        request(r.state!.id, { description: { [locale]: 'x'.repeat(5001) } }),
      );
      expect(outcome).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(r.stored).toHaveLength(0);
    });

    it('refuses the whole create when a text carries a claim, and stores nothing', async () => {
      const r = rig({
        verdicts: (texts) =>
          texts.map((item) => ({
            code: 'claim-text.found' as const,
            field: 'offer.description' as const,
            ref: null,
            locale: item.locale,
            hits: [],
          })),
      });
      const outcome = await r.useCase.execute(contextOf('seller'), request(r.state!.id));
      expect(outcome).toMatchObject({ ok: false, error: { code: 'claim-text.refused' } });
      expect(r.stored).toHaveLength(0);
      expect(r.events).toHaveLength(0);
    });

    it('skips the claim check for an empty description', async () => {
      const r = rig();
      const outcome = await r.useCase.execute(
        contextOf('seller'),
        request(r.state!.id, { description: {} }),
      );
      expect(outcome.ok).toBe(true);
      expect(r.checked).toHaveLength(0);
    });

    it.each([
      ['an unknown product', null],
      ['a SELLER product', 'seller'],
      ['an unpublished product', 'draft'],
      ['a retired product', 'retired'],
    ] as const)('answers a byte-identical product.not-found for %s', async (_label, kind) => {
      const product =
        kind === null
          ? null
          : kind === 'seller'
            ? productState({
                scope: 'SELLER',
                ownerSellerId: sellerId,
                createdBySellerId: sellerId,
              })
            : kind === 'draft'
              ? productState({ status: 'draft', publishedRevisionId: null })
              : productState({ status: 'retired' });
      const r = rig({ product });
      const outcome = await r.useCase.execute(
        contextOf('seller'),
        request(product?.id ?? ids.next<'Product'>()),
      );
      expect(outcome).toEqual({ ok: false, error: { code: 'product.not-found' } });
      expect(r.stored).toHaveLength(0);
    });

    it('applies SEL-12: a type outside the allowed set, and an error, both refuse', async () => {
      const notAllowed = rig({ allowed: new Set(['configurable']) });
      expect(
        await notAllowed.useCase.execute(contextOf('seller'), request(notAllowed.state!.id)),
      ).toEqual({
        ok: false,
        error: { code: 'type.not-allowed' },
      });
      const errored = rig({ allowed: null });
      expect(
        await errored.useCase.execute(contextOf('seller'), request(errored.state!.id)),
      ).toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
      const allowedExplicit = rig({ allowed: new Set(['simple']) });
      expect(
        (
          await allowedExplicit.useCase.execute(
            contextOf('seller'),
            request(allowedExplicit.state!.id),
          )
        ).ok,
      ).toBe(true);
    });

    it.each(['offer.exists-for-product', 'offer.sku-taken'] as const)(
      'maps the %s refusal of the store to an error and appends no event',
      async (refusal) => {
        const r = rig({ addRefusal: refusal });
        const outcome = await r.useCase.execute(contextOf('seller'), request(r.state!.id));
        expect(outcome).toEqual({ ok: false, error: { code: refusal } });
        expect(r.events).toHaveLength(0);
      },
    );
  },
);
