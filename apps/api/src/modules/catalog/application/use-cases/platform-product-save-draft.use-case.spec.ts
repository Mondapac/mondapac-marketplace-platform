import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, MarketId, Result } from '@mondapac/shared-kernel';
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
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { Product } from '../../domain/product';
import { configurableProductType } from '../../domain/product-types/configurable';
import type { RateReservation } from '../../domain/rate-limits';
import type { WorkingCopy } from '../../domain/working-copy';
import { HmacRateCounterKeys } from '../../infrastructure/hmac-rate-counter-keys';
import { unavailableClaimTextMatcher } from '../../../../../test/support/unavailable-claim-text-matcher.fake';
import { CheckClaimText } from '../claim-text/check-claim-text.service';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ClaimTextMatcher, ClaimTextToMatch } from '../ports/claim-text-matcher';
import type { ProductRepository } from '../ports/product.repository';
import type { RateCounter, RateCounterRepository } from '../ports/rate-counter.repository';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import { SaveDraft } from '../working-copy/save-draft.service';
import { SaveWorkingCopy } from '../working-copy/save-working-copy.service';
import {
  PlatformProductSaveDraft,
  type PlatformProductSaveDraftInput,
} from './platform-product-save-draft.use-case';

// `platform-product.save-draft` in memory (catalog design 6.1, 8.2; slice 6), on both Market
// fixtures: the per-field claim-text refusal (a refused text keeps its last saved value, the rest
// of the request is saved), the closed draft shape, the author from the actor, the check limit
// not spent by a save. The gate admits every authenticated actor; the declaration is checked by
// the CI list. The database behaviour is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);

const FIXTURES = [
  { code: 'AU', locales: { default: 'en', supported: ['en', 'ar'] } },
  { code: 'ZZ', locales: { default: 'zz', supported: ['zz', 'en'] } },
] as const;
const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const HIT = { typeCode: 'type-a', span: { fromToken: 0, toToken: 0 } };

describe.each(FIXTURES)('platform-product.save-draft in market $code', ({ code, locales }) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const locale = locales.default;

  const contextOf = (population: 'admin' | 'seller' | 'customer'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? ids.next<'Seller'>() : null,
      }),
    );

  function newProduct(scope: 'SELLER' | 'PLATFORM' = 'PLATFORM'): Product {
    const sellerId = ids.next<'Seller'>();
    const created = Product.create({
      id: ids.next<'Product'>(),
      marketId: code as MarketId,
      scope,
      sellerId: scope === 'SELLER' ? sellerId : null,
      handler: configurableProductType,
      familyCode: 'default',
      productCode: 'P00000001',
      variantId: null,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    return Product.restore({ ...created.value.state, version: 1 });
  }

  function rig(matcherOverride?: ClaimTextMatcher) {
    const stored = new Map<string, Product>();
    const copies = new Map<string, WorkingCopy>();
    const counters = new Map<string, number>();
    const matched: ClaimTextToMatch[][] = [];
    const matcher: ClaimTextMatcher = matcherOverride ?? {
      match: (_c, texts) => {
        matched.push([...texts]);
        return Promise.resolve({
          ok: true as const,
          value: texts.map((item) => (item.text.includes('halal') ? [HIT] : [])),
        });
      },
    };
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const products: ProductRepository = {
      nextProductCode: () => Promise.resolve('P00000001'),
      add: () => Promise.resolve(),
      findById: (_m, id) => Promise.resolve(stored.get(id) ?? null),
      save: (_m, product) => {
        stored.set(product.state.id, Product.restore({ ...product.state }));
        return Promise.resolve();
      },
    };
    const workingCopies: WorkingCopyRepository = {
      find: (_m, id) => Promise.resolve(copies.get(id) ?? null),
      save: (_m, copy) => {
        copies.set(copy.productId, copy);
        return Promise.resolve();
      },
    };
    const counterRepo: RateCounterRepository = {
      reserve: (_m, wanted: readonly RateCounter[], now) =>
        Promise.resolve(
          wanted.map((counter): RateReservation => {
            const key = `${counter.limit.kind}:${Buffer.from(counter.keyHash).toString('hex')}`;
            const count = (counters.get(key) ?? 0) + 1;
            counters.set(key, count);
            return { kind: counter.limit.kind, count, windowStartedAt: now };
          }),
        ),
      purgeStartedBefore: () => Promise.resolve(0),
    };
    const policy: CatalogMarketPolicy = {
      taxCategoryCodes: () => [],
      locales: () => ({ default: locales.default, supported: [...locales.supported] }),
      sensitiveChanges: () => {
        throw new Error('not used');
      },
      maxVariantsPerProduct: () => 100,
      productTypes: () => ['simple', 'configurable'],
      defaultFamily: () => 'default',
      approvalRequired: () => Promise.resolve(true),
    };
    const outbox: OutboxWriter = { append: () => Promise.resolve() };
    const counterKeys = new HmacRateCounterKeys(new Uint8Array(32).fill(7));
    const check = new CheckClaimText({
      unitOfWork,
      matcher,
      counters: counterRepo,
      counterKeys,
      policy,
      clock,
    });
    const save = new SaveWorkingCopy({
      unitOfWork,
      products,
      workingCopies,
      counters: counterRepo,
      counterKeys,
      policy,
      outbox,
      clock,
      ids,
    });
    const saveDraft = new SaveDraft({ unitOfWork, check, save, workingCopies, policy });
    const useCase = new PlatformProductSaveDraft(gate, { saveDraft });
    return { useCase, stored, copies, matched, check, counters };
  }

  const request = (
    productId: string,
    content: unknown,
    variantIds: (string | null)[] = [],
  ): PlatformProductSaveDraftInput => ({ productId, content, variantIds });

  it('saves a clean draft and reports no refused field', async () => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);
    const content = { texts: { [locale]: { name: 'Dates', description: 'Sweet' } } };

    const saved = await r.useCase.execute(contextOf('admin'), request(product.state.id, content));

    expect(saved).toEqual({ ok: true, value: { variantIds: [], refusedFields: [] } });
    expect(r.copies.get(product.state.id)?.content).toEqual(content);
  });

  it('does not write a text that matches; it keeps its last saved value and the rest is saved', async () => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);
    const admin = contextOf('admin');
    await r.useCase.execute(
      admin,
      request(product.state.id, { texts: { [locale]: { name: 'Dates' } } }),
    );

    const saved = await r.useCase.execute(
      admin,
      request(product.state.id, {
        texts: { [locale]: { name: 'Dates halal', description: 'Sweet' } },
        taxCategoryCode: 'taxable',
      }),
    );

    expect(saved.ok && saved.value.refusedFields).toEqual([
      {
        field: 'product.name',
        ref: null,
        locale,
        code: 'claim-text.found',
        hits: [HIT],
      },
    ]);
    expect(r.copies.get(product.state.id)?.content).toEqual({
      texts: { [locale]: { name: 'Dates', description: 'Sweet' } },
      taxCategoryCode: 'taxable',
    });
    expect(JSON.stringify([...r.copies.values()])).not.toContain('halal');
  });

  it('stores no value at all for a refused text that had none', async () => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);

    const saved = await r.useCase.execute(
      contextOf('admin'),
      request(product.state.id, { texts: { [locale]: { name: 'halal' } }, imageIds: [] }),
    );

    expect(saved.ok && saved.value.refusedFields).toHaveLength(1);
    expect(r.copies.get(product.state.id)?.content).toEqual({
      texts: { [locale]: {} },
      imageIds: [],
    });
  });

  it('checks only the texts that changed', async () => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);
    const admin = contextOf('admin');
    const first = { texts: { [locale]: { name: 'Dates', description: 'Sweet' } } };
    await r.useCase.execute(admin, request(product.state.id, first));
    r.matched.length = 0;

    await r.useCase.execute(
      admin,
      request(product.state.id, {
        texts: { [locale]: { name: 'Dates', description: 'Very sweet' } },
      }),
    );
    expect(r.matched.flat().map((item) => item.text)).toEqual(['Very sweet']);

    r.matched.length = 0;
    await r.useCase.execute(
      admin,
      request(product.state.id, {
        texts: { [locale]: { name: 'Dates', description: 'Very sweet' } },
      }),
    );
    expect(r.matched).toHaveLength(0);
  });

  it('refuses every new text, and saves the rest, while the matcher is the placeholder', async () => {
    const r = rig(unavailableClaimTextMatcher);
    const product = newProduct();
    r.stored.set(product.state.id, product);

    const saved = await r.useCase.execute(
      contextOf('admin'),
      request(product.state.id, {
        texts: { [locale]: { name: 'Dates' } },
        taxCategoryCode: 'taxable',
      }),
    );

    expect(saved.ok && saved.value.refusedFields).toEqual([
      { field: 'product.name', ref: null, locale, code: 'claim-text.check-unavailable' },
    ]);
    expect(r.copies.get(product.state.id)?.content).toEqual({
      texts: { [locale]: {} },
      taxCategoryCode: 'taxable',
    });
  });

  it('reports a hidden character with its offset and does not write the text', async () => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);

    const saved = await r.useCase.execute(
      contextOf('admin'),
      request(product.state.id, { texts: { [locale]: { name: 'ab‮cd' } } }),
    );

    expect(saved.ok && saved.value.refusedFields).toEqual([
      {
        field: 'product.name',
        ref: null,
        locale,
        code: 'text.invisible-character',
        offset: 2,
        character: 'other',
      },
    ]);
    expect(JSON.stringify([...r.copies.values()])).not.toContain('‮');
  });

  it.each([
    ['an unknown key', { extra: 'halal' }],
    ['a locale the Market does not list', { texts: { fr: { name: 'x' } } }],
    ['a nested text', { texts: { [locale]: { name: { deep: 'halal' } } } }],
  ])('refuses %s as a whole and writes nothing', async (_name, content) => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);

    const saved = await r.useCase.execute(contextOf('admin'), request(product.state.id, content));

    expect(saved).toEqual({ ok: false, error: { code: 'working-copy.invalid-content' } });
    expect(r.copies.size).toBe(0);
    expect(r.matched).toHaveLength(0);
  });

  it('refuses a seller and a customer, and an admin on a SELLER product (CAT-43)', async () => {
    const r = rig();
    const platform = newProduct('PLATFORM');
    const sellers = newProduct('SELLER');
    r.stored.set(platform.state.id, platform);
    r.stored.set(sellers.state.id, sellers);

    for (const population of ['seller', 'customer'] as const) {
      const denied = await r.useCase.execute(contextOf(population), request(platform.state.id, {}));
      expect(denied).toEqual({ ok: false, error: { code: 'access.denied' } });
    }
    const crossed = await r.useCase.execute(contextOf('admin'), request(sellers.state.id, {}));
    expect(crossed.ok).toBe(false);
    expect(r.copies.size).toBe(0);
  });

  it.each([
    [
      'a product id that is not an id',
      { productId: 'nope', content: {}, variantIds: [] },
      'productId',
    ],
    [
      'variant ids that are not a list',
      { productId: 'x', content: {}, variantIds: 'v' },
      'variantIds',
    ],
  ])('refuses %s with a fixed path', async (_name, input, path) => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);
    const body = {
      ...input,
      productId: path === 'productId' ? input.productId : product.state.id,
    };
    const saved = await r.useCase.execute(
      contextOf('admin'),
      body as PlatformProductSaveDraftInput,
    );
    expect(saved).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [{ path, code: path === 'productId' ? 'format' : 'type' }],
      },
    });
  });

  it('does not spend the claim-text check limit', async () => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);
    const admin = contextOf('admin');
    for (let index = 0; index < 40; index += 1) {
      const saved = await r.useCase.execute(
        admin,
        request(product.state.id, { texts: { [locale]: { name: `Dates ${index}` } } }),
      );
      expect(saved.ok).toBe(true);
    }
    expect(await r.check.reserveCheckLimit(admin, 1)).toBeNull();
  });

  it('answers request.throttled after 60 saves a minute, with nothing more written', async () => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);
    const admin = contextOf('admin');
    for (let index = 0; index < 60; index += 1) {
      await r.useCase.execute(admin, request(product.state.id, {}));
    }
    const refused = await r.useCase.execute(admin, request(product.state.id, {}));
    expect(refused).toEqual({
      ok: false,
      error: { code: 'request.throttled', retryAfterSeconds: 60 },
    });
    // The limit is spent before the check: a throttled save costs the matcher nothing.
    r.matched.length = 0;
    await r.useCase.execute(
      admin,
      request(product.state.id, { texts: { [locale]: { name: 'Dates' } } }),
    );
    expect(r.matched).toHaveLength(0);
  });

  it('refuses a draft that repeats a variant id before anything is checked or written', async () => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);
    const saved = await r.useCase.execute(
      contextOf('admin'),
      request(product.state.id, {
        variants: [
          { variantId: 'v1', labels: { [locale]: 'Large' } },
          { variantId: 'v1', labels: { [locale]: 'halal' } },
        ],
      }),
    );
    expect(saved).toEqual({ ok: false, error: { code: 'working-copy.invalid-content' } });
    expect(r.matched).toHaveLength(0);
    expect(r.copies.has(product.state.id)).toBe(false);
  });
});
