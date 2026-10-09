import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, MarketId, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { Product } from '../../domain/product';
import { configurableProductType } from '../../domain/product-types/configurable';
import type { RateReservation } from '../../domain/rate-limits';
import type { WorkingCopy } from '../../domain/working-copy';
import { HmacRateCounterKeys } from '../../infrastructure/hmac-rate-counter-keys';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductRepository } from '../ports/product.repository';
import type { RateCounter, RateCounterRepository } from '../ports/rate-counter.repository';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import { SaveWorkingCopy } from './save-working-copy.service';

// SaveWorkingCopy (catalog design 4.2, slice 4c-3) over in-memory ports, for both Market
// fixtures: author from the actor, ownership as a byte-identical not-found, the saves limit
// reserved first and fail-closed, events appended in the unit, a lost race as conflict.stale.
// The PostgreSQL behaviour is in test/db/catalog-working-copy.db-spec.ts.

const FIXTURES = [
  { code: 'AU', maxVariants: 100 },
  { code: 'ZZ', maxVariants: 3 },
] as const;
const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');

describe.each(FIXTURES)('SaveWorkingCopy in market $code', ({ code, maxVariants }) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const sellerId = ids.next<'Seller'>();
  const otherSellerId = ids.next<'Seller'>();

  const actorContext = (
    population: 'seller' | 'admin' | 'customer',
    owner = sellerId,
  ): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? owner : null,
      }),
    );

  function newProduct(scope: 'SELLER' | 'PLATFORM' = 'SELLER'): Product {
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

  interface Rig {
    service: SaveWorkingCopy;
    stored: Map<string, Product>;
    copies: Map<string, WorkingCopy>;
    appended: string[];
    counters: Map<string, number>;
    failCounters: { value: boolean };
    stale: { value: boolean };
  }

  function rig(policy: 'answers' | 'throws' = 'answers'): Rig {
    const stored = new Map<string, Product>();
    const copies = new Map<string, WorkingCopy>();
    const appended: string[] = [];
    const counters = new Map<string, number>();
    const failCounters = { value: false };
    const stale = { value: false };
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const products: ProductRepository = {
      nextProductCode: () => Promise.resolve('P00000001'),
      add: () => Promise.resolve(),
      findById: (_m, id) => Promise.resolve(stored.get(id) ?? null),
      save: (_m, product) => {
        if (stale.value)
          return Promise.reject(new StaleAggregateError('product', product.state.id));
        stored.set(
          product.state.id,
          Product.restore({ ...product.state, version: product.state.version }),
        );
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
      reserve: (_m, wanted: readonly RateCounter[], now) => {
        if (failCounters.value) return Promise.reject(new Error('store down'));
        return Promise.resolve(
          wanted.map((counter): RateReservation => {
            const key = `${counter.limit.kind}:${Buffer.from(counter.keyHash).toString('hex')}`;
            const count = (counters.get(key) ?? 0) + 1;
            counters.set(key, count);
            return { kind: counter.limit.kind, count, windowStartedAt: now };
          }),
        );
      },
      purgeStartedBefore: () => Promise.resolve(0),
    };
    const marketPolicy: CatalogMarketPolicy = {
      taxCategoryCodes: () => [],
      locales: () => ({ default: 'en', supported: ['en'] }),
      sensitiveChanges: () => {
        throw new Error('not used');
      },
      maxVariantsPerProduct: () => {
        if (policy === 'throws') throw new Error('policy down');
        return maxVariants;
      },
      productTypes: () => ['simple', 'configurable'],
      defaultFamily: () => 'default',
      conditions: () => ['new'],
      sellFromCatalogue: () => Promise.resolve(true),
      approvalRequired: () => Promise.resolve(true),
    };
    const outbox: OutboxWriter = {
      append: (_c, events) => {
        appended.push(...events.map((event) => event.type));
        return Promise.resolve();
      },
    };
    const service = new SaveWorkingCopy({
      unitOfWork,
      products,
      workingCopies,
      counters: counterRepo,
      counterKeys: new HmacRateCounterKeys(new Uint8Array(32).fill(7)),
      policy: marketPolicy,
      outbox,
      clock,
      ids,
    });
    return { service, stored, copies, appended, counters, failCounters, stale };
  }

  it('stores the draft, mints the new variants in order and appends their events', async () => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);

    const saved = await r.service.execute(actorContext('seller'), {
      productId: product.state.id,
      content: { texts: { en: { name: 'Dates' } } },
      variantIds: [null, null],
    });

    expect(saved.ok && saved.value.variantIds).toHaveLength(2);
    expect(r.copies.get(product.state.id)?.content).toEqual({ texts: { en: { name: 'Dates' } } });
    expect(r.appended).toEqual(['catalog.variant-added.v1', 'catalog.variant-added.v1']);
    expect(r.stored.get(product.state.id)?.state.version).toBe(3);
  });

  it('refuses a product that is another seller’s with the answer of a missing one', async () => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);

    const foreign = await r.service.execute(actorContext('seller', otherSellerId), {
      productId: product.state.id,
      content: {},
      variantIds: [],
    });
    const missing = await r.service.execute(actorContext('seller'), {
      productId: ids.next<'Product'>(),
      content: {},
      variantIds: [],
    });

    expect(foreign).toEqual({ ok: false, error: { code: 'product.not-found' } });
    expect(foreign).toEqual(missing);
    expect(r.copies.size).toBe(0);
  });

  it('refuses a seller on a PLATFORM product and an admin on a SELLER product (CAT-43)', async () => {
    const r = rig();
    const platform = newProduct('PLATFORM');
    const sellers = newProduct('SELLER');
    r.stored.set(platform.state.id, platform);
    r.stored.set(sellers.state.id, sellers);

    const sellerOnPlatform = await r.service.execute(actorContext('seller'), {
      productId: platform.state.id,
      content: {},
      variantIds: [],
    });
    const adminOnSeller = await r.service.execute(actorContext('admin'), {
      productId: sellers.state.id,
      content: {},
      variantIds: [],
    });

    expect(sellerOnPlatform.ok).toBe(false);
    expect(adminOnSeller.ok).toBe(false);
    expect(r.copies.size).toBe(0);
    expect(r.appended).toEqual([]);
  });

  it('answers access.denied to a customer, an anonymous caller and the system actor', async () => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);
    for (const context of [
      actorContext('customer'),
      testCallContext(market, 'anonymous'),
      testCallContext(market, 'system'),
    ]) {
      const refused = await r.service.execute(context, {
        productId: product.state.id,
        content: {},
        variantIds: [],
      });
      expect(refused).toEqual({ ok: false, error: { code: 'access.denied' } });
    }
    expect(r.counters.size).toBe(0);
  });

  it.each([
    ['an array', []],
    ['null', null],
    ['a string', 'text'],
    ['a NUL character', { a: 'x\u0000y' }],
    ['an unpaired surrogate', { a: '\ud800' }],
    ['an object over the size cap', { text: 'x'.repeat(300 * 1024) }],
  ])('refuses %s as content before reserving anything', async (_name, content) => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);
    const refused = await r.service.execute(actorContext('seller'), {
      productId: product.state.id,
      content,
      variantIds: [],
    });
    expect(refused).toEqual({ ok: false, error: { code: 'working-copy.invalid-content' } });
    expect(r.counters.size).toBe(0);
  });

  it('throttles the 61st save in a minute and keeps the refused attempt counted', async () => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);
    const context = actorContext('seller');
    let last: Awaited<ReturnType<SaveWorkingCopy['execute']>> | undefined;
    for (let attempt = 0; attempt < 61; attempt += 1) {
      last = await r.service.execute(context, {
        productId: product.state.id,
        content: { n: attempt },
        variantIds: [],
      });
    }
    expect(last).toEqual({
      ok: false,
      error: { code: 'request.throttled', retryAfterSeconds: 60 },
    });
    expect(
      [...r.counters.entries()].find(([key]) => key.startsWith('draft-save.account.minute'))?.[1],
    ).toBe(61);
    expect(r.copies.get(product.state.id)?.content).toEqual({ n: 59 });
  });

  it('fails closed with access.unavailable when the counter store errors', async () => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);
    r.failCounters.value = true;
    const refused = await r.service.execute(actorContext('seller'), {
      productId: product.state.id,
      content: {},
      variantIds: [],
    });
    expect(refused).toEqual({ ok: false, error: { code: 'access.unavailable' } });
    expect(r.copies.size).toBe(0);
  });

  it('refuses a save over the Market’s variant limit and stores nothing', async () => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);
    const refused = await r.service.execute(actorContext('seller'), {
      productId: product.state.id,
      content: {},
      variantIds: Array.from({ length: maxVariants + 1 }, () => null),
    });
    expect(refused).toEqual({
      ok: false,
      error: { code: 'variant.limit-reached', max: maxVariants },
    });
    expect(r.copies.size).toBe(0);
    expect(r.appended).toEqual([]);
  });

  it('answers conflict.stale when the product changed under the save', async () => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);
    r.stale.value = true;
    const refused = await r.service.execute(actorContext('seller'), {
      productId: product.state.id,
      content: {},
      variantIds: [null],
    });
    expect(refused).toEqual({ ok: false, error: { code: 'conflict.stale' } });
  });

  it('keeps the base revision of the previous copy', async () => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);
    const base = ids.next<'ProductRevision'>();
    r.copies.set(product.state.id, {
      productId: product.state.id,
      content: {},
      contentSchemaVersion: 1,
      baseRevisionId: base,
      lastSavedAt: T0,
      lastSavedByAccountId: ids.next<'Account'>(),
    });
    await r.service.execute(actorContext('seller'), {
      productId: product.state.id,
      content: { a: 1 },
      variantIds: [],
    });
    expect(r.copies.get(product.state.id)?.baseRevisionId).toBe(base);
  });

  it('throttles one account without throttling another', async () => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);
    const busy = actorContext('seller');
    for (let attempt = 0; attempt < 61; attempt += 1) {
      await r.service.execute(busy, { productId: product.state.id, content: {}, variantIds: [] });
    }
    const other = await r.service.execute(actorContext('seller'), {
      productId: product.state.id,
      content: {},
      variantIds: [],
    });
    expect(other.ok).toBe(true);
  });

  it('answers access.unavailable when the Market policy cannot answer, storing nothing', async () => {
    const r = rig('throws');
    const product = newProduct();
    r.stored.set(product.state.id, product);
    const refused = await r.service.execute(actorContext('seller'), {
      productId: product.state.id,
      content: {},
      variantIds: [],
    });
    expect(refused).toEqual({ ok: false, error: { code: 'access.unavailable' } });
    expect(r.copies.size).toBe(0);
  });

  it('accepts a save to exactly the Market limit', async () => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);
    const saved = await r.service.execute(actorContext('seller'), {
      productId: product.state.id,
      content: {},
      variantIds: Array.from({ length: maxVariants }, () => null),
    });
    expect(saved.ok && saved.value.variantIds).toHaveLength(maxVariants);
  });

  it('refuses a variant id of another product, the same as an invented one, minting nothing', async () => {
    const r = rig();
    const product = newProduct();
    r.stored.set(product.state.id, product);
    const foreign = await r.service.execute(actorContext('seller'), {
      productId: product.state.id,
      content: {},
      variantIds: [ids.next<'Variant'>(), null],
    });
    expect(foreign).toEqual({ ok: false, error: { code: 'variant.unknown' } });
    expect(r.copies.size).toBe(0);
    expect(r.appended).toEqual([]);
  });

  it('hides a PLATFORM product from a seller as not found and names the refusal for an admin on a SELLER one', async () => {
    const r = rig();
    const platform = newProduct('PLATFORM');
    const sellers = newProduct('SELLER');
    r.stored.set(platform.state.id, platform);
    r.stored.set(sellers.state.id, sellers);
    expect(
      await r.service.execute(actorContext('seller'), {
        productId: platform.state.id,
        content: {},
        variantIds: [],
      }),
    ).toEqual({ ok: false, error: { code: 'product.not-found' } });
    expect(
      await r.service.execute(actorContext('admin'), {
        productId: sellers.state.id,
        content: {},
        variantIds: [],
      }),
    ).toEqual({ ok: false, error: { code: 'product.seller-only' } });
  });
});
