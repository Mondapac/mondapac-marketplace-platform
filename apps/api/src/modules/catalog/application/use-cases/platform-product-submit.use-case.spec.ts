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
import { simpleProductType } from '../../domain/product-types/simple';
import type { StoredRevision } from '../../domain/stored-revision';
import { FreezeRevision } from '../revisions/freeze-revision.service';
import { SubmitProduct } from '../revisions/submit-product.service';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { AttributeRepository } from '../ports/attribute.repository';
import { Product } from '../../domain/product';
import type { WorkingCopy } from '../../domain/working-copy';
import { HmacRateCounterKeys } from '../../infrastructure/hmac-rate-counter-keys';
import { unavailableClaimTextMatcher } from '../../../../../test/support/unavailable-claim-text-matcher.fake';
import { CheckClaimText } from '../claim-text/check-claim-text.service';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ClaimTextMatcher, ClaimTextToMatch } from '../ports/claim-text-matcher';
import type { ProductRepository } from '../ports/product.repository';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import {
  PlatformProductSubmit,
  type PlatformProductSubmitInput,
} from './platform-product-submit.use-case';

// `platform-product.submit` in memory (catalog design 4.2 row 1, 6; slice 6), on both Market
// fixtures: the freeze, the claim-text check over every text of the frozen content, the admin
// outcome (published at once), the stored revision, and the refusals that store nothing. The
// gate admits every authenticated actor; the declaration is checked by the CI list. The database
// behaviour is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);

const FIXTURES = [
  { code: 'AU', locales: { default: 'en', supported: ['en', 'ar'] }, tax: 'GST' },
  { code: 'ZZ', locales: { default: 'zz', supported: ['zz', 'en'] }, tax: 'STD' },
] as const;
const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const HIT = { typeCode: 'type-a', span: { fromToken: 0, toToken: 0 } };

describe.each(FIXTURES)('platform-product.submit in market $code', ({ code, locales, tax }) => {
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
    const created = Product.create({
      id: ids.next<'Product'>(),
      marketId: code as MarketId,
      scope,
      sellerId: scope === 'SELLER' ? ids.next<'Seller'>() : null,
      handler: simpleProductType,
      familyCode: 'default',
      productCode: 'P00000001',
      variantId: ids.next<'Variant'>(),
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    return Product.restore({ ...created.value.state, version: 1 });
  }

  const draft = (extra: Record<string, unknown> = {}): WorkingCopy['content'] => ({
    texts: { [locale]: { name: 'Dates', description: 'Sweet and soft' } },
    categoryIds: ['c1'],
    taxCategoryCode: tax,
    ...extra,
  });

  function rig(
    matcherOverride?: ClaimTextMatcher,
    options: {
      approvalThrows?: boolean;
      noSchema?: boolean;
      gateOverride?: AuthorisationCheck;
    } = {},
  ) {
    const stored = new Map<string, Product>();
    const copies = new Map<string, WorkingCopy>();
    const revisions = new Map<string, StoredRevision>();
    const matched: ClaimTextToMatch[][] = [];
    const events: unknown[] = [];
    // Units do not nest and the real matcher opens its own: a call inside an open unit is a bug.
    let openUnits = 0;
    const matcher: ClaimTextMatcher = matcherOverride ?? {
      match: (_c, texts) => {
        if (openUnits > 0) throw new Error('the matcher was called inside an open unit');
        matched.push([...texts]);
        return Promise.resolve({
          ok: true as const,
          value: texts.map((item) => (item.text.includes('halal') ? [HIT] : [])),
        });
      },
    };
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => {
        if (openUnits > 0) throw new Error('units do not nest');
        openUnits += 1;
        try {
          return await work();
        } finally {
          openUnits -= 1;
        }
      },
    } as unknown as UnitOfWork;
    const products: ProductRepository = {
      nextProductCode: () => Promise.resolve('P00000001'),
      add: () => Promise.resolve(),
      findById: (_m, id) => {
        const found = stored.get(id);
        return Promise.resolve(found === undefined ? null : Product.restore({ ...found.state }));
      },
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
    const revisionRepo: ProductRevisionRepository = {
      nextRevisionNo: (_m, productId) =>
        Promise.resolve(
          [...revisions.values()].filter((revision) => revision.productId === productId).length + 1,
        ),
      add: (_m, revision) => {
        revisions.set(revision.id, revision);
        return Promise.resolve();
      },
      find: (_m, productId, id) => {
        const found = revisions.get(id);
        return Promise.resolve(found?.productId === productId ? found : null);
      },
    };
    const policy: CatalogMarketPolicy = {
      taxCategoryCodes: () => [tax],
      locales: () => ({ default: locales.default, supported: [...locales.supported] }),
      sensitiveChanges: () => ({
        platformCategories: true,
        taxCategory: true,
        name: true,
        primaryImage: true,
        anyImage: false,
        variantRemoved: true,
      }),
      maxVariantsPerProduct: () => 100,
      productTypes: () => ['simple', 'configurable'],
      defaultFamily: () => 'default',
      conditions: () => ['new'],
      sellFromCatalogue: () => Promise.resolve(true),
      approvalRequired: () =>
        options.approvalThrows === true
          ? Promise.reject(new Error('config'))
          : Promise.resolve(true),
    };
    const outbox: OutboxWriter = {
      append: (_c, list) => {
        events.push(...list);
        return Promise.resolve();
      },
    };
    const counterRepo: RateCounterRepository = {
      reserve: () => Promise.reject(new Error('submit spends no counter')),
      purgeStartedBefore: () => Promise.resolve(0),
    };
    const check = new CheckClaimText({
      unitOfWork,
      matcher,
      counters: counterRepo,
      counterKeys: new HmacRateCounterKeys(new Uint8Array(32).fill(7)),
      policy,
      clock,
    });
    const attributes = {
      loadSchema: () =>
        Promise.resolve(
          options.noSchema === true
            ? null
            : {
                schemaRef: {
                  familyCode: 'default',
                  familyRevisionId: 'fam-rev-1',
                  definitionRevisionIds: [],
                },
                fields: [
                  {
                    code: 'note',
                    dataType: 'text',
                    localizable: true,
                    required: false,
                    isVariantOption: false,
                    material: false,
                    claimChecked: true,
                    bounds: { maxLength: 50 },
                  },
                ],
              },
        ),
    } as unknown as AttributeRepository;
    const freeze = new FreezeRevision({
      attributes,
      policy,
      handlerFor: (typeCode) => (typeCode === 'simple' ? simpleProductType : undefined),
    });
    const submit = new SubmitProduct({
      unitOfWork,
      products,
      workingCopies,
      revisions: revisionRepo,
      freeze,
      check,
      policy,
      outbox,
      clock,
      ids,
    });
    const useCase = new PlatformProductSubmit(
      options.gateOverride === undefined ? gate : createUseCaseGate(markets, options.gateOverride),
      { submit },
    );
    const seed = (product: Product, content: WorkingCopy['content'] | null = draft()) => {
      stored.set(product.state.id, product);
      if (content !== null) {
        copies.set(product.state.id, {
          productId: product.state.id,
          content,
          contentSchemaVersion: 1,
          baseRevisionId: null,
          lastSavedAt: T0,
          lastSavedByAccountId: ids.next<'Account'>(),
        });
      }
    };
    return { useCase, stored, copies, revisions, matched, events, seed };
  }

  const request = (productId: string, replacePending = false): PlatformProductSubmitInput => ({
    productId,
    replacePending,
  });

  it('checks every text, stores revision 1 and publishes at once for an admin', async () => {
    const r = rig();
    const product = newProduct();
    r.seed(product);
    const submitted = await r.useCase.execute(contextOf('admin'), request(product.state.id));
    expect(submitted.ok && submitted.value).toMatchObject({ revisionNo: 1, published: true });
    expect(r.matched.flat().map((item) => item.text)).toEqual(['Dates', 'Sweet and soft']);
    expect(r.revisions.size).toBe(1);
    const revision = [...r.revisions.values()][0]!;
    expect(revision).toMatchObject({
      kind: 'submission',
      authorKind: 'admin',
      baseRevisionId: null,
    });
    expect(r.stored.get(product.state.id)?.state.publishedRevisionId).toBe(revision.id);
    expect(r.events.length).toBeGreaterThan(0);
  });

  it('numbers the next revision after the published one and names it as the base', async () => {
    const r = rig();
    const product = newProduct();
    r.seed(product);
    const first = await r.useCase.execute(contextOf('admin'), request(product.state.id));
    const second = await r.useCase.execute(contextOf('admin'), request(product.state.id));
    expect(first.ok && second.ok).toBe(true);
    expect(second.ok && second.value.revisionNo).toBe(2);
    expect([...r.revisions.values()][1]?.baseRevisionId).toBe(
      first.ok ? first.value.revisionId : null,
    );
  });

  it('refuses the whole submit, and stores nothing, when a stored text matches', async () => {
    const r = rig();
    const product = newProduct();
    r.seed(product, draft({ texts: { [locale]: { name: 'Dates', description: 'halal dates' } } }));
    const submitted = await r.useCase.execute(contextOf('admin'), request(product.state.id));
    expect(submitted).toEqual({
      ok: false,
      error: {
        code: 'claim-text.refused',
        fields: [
          {
            field: 'product.description',
            ref: null,
            locale,
            code: 'claim-text.found',
            hits: [HIT],
          },
        ],
      },
    });
    expect(r.revisions.size).toBe(0);
    expect(r.stored.get(product.state.id)?.state.publishedRevisionId).toBeNull();
  });

  it('refuses every text while the matcher is the placeholder', async () => {
    const r = rig(unavailableClaimTextMatcher);
    const product = newProduct();
    r.seed(product);
    const submitted = await r.useCase.execute(contextOf('admin'), request(product.state.id));
    expect(!submitted.ok && submitted.error.code).toBe('claim-text.refused');
    expect(r.revisions.size).toBe(0);
  });

  it('refuses with conflict.stale when the draft changes between the check and the store', async () => {
    const changing: { change?: () => void } = {};
    const r = rig({
      match: (_c, texts) => {
        changing.change?.();
        return Promise.resolve({ ok: true as const, value: texts.map(() => []) });
      },
    });
    const product = newProduct();
    r.seed(product);
    changing.change = () => {
      const copy = r.copies.get(product.state.id)!;
      r.copies.set(product.state.id, {
        ...copy,
        content: draft({
          texts: { [locale]: { name: 'Dates', description: 'Edited after the check' } },
        }),
      });
    };
    const submitted = await r.useCase.execute(contextOf('admin'), request(product.state.id));
    expect(submitted).toEqual({ ok: false, error: { code: 'conflict.stale' } });
    expect(r.revisions.size).toBe(0);
  });

  it('lists what is not ready and does not check or store', async () => {
    const r = rig();
    const product = newProduct();
    r.seed(product, draft({ categoryIds: [] }));
    const submitted = await r.useCase.execute(contextOf('admin'), request(product.state.id));
    expect(!submitted.ok && submitted.error).toEqual({
      code: 'revision.not-ready',
      issues: [{ path: 'categoryIds', code: 'required' }],
    });
    expect(r.matched).toHaveLength(0);
    expect(r.revisions.size).toBe(0);
  });

  it('refuses a seller and a customer, a SELLER product, a missing product and a missing draft', async () => {
    const r = rig();
    const product = newProduct();
    r.seed(product);
    for (const population of ['seller', 'customer'] as const) {
      expect(await r.useCase.execute(contextOf(population), request(product.state.id))).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
    const owned = newProduct('SELLER');
    r.seed(owned);
    expect(await r.useCase.execute(contextOf('admin'), request(owned.state.id))).toEqual({
      ok: false,
      error: { code: 'product.platform-admin-only' },
    });
    expect(await r.useCase.execute(contextOf('admin'), request(ids.next<'Product'>()))).toEqual({
      ok: false,
      error: { code: 'product.not-found' },
    });
    const bare = newProduct();
    r.seed(bare, null);
    expect(await r.useCase.execute(contextOf('admin'), request(bare.state.id))).toEqual({
      ok: false,
      error: { code: 'working-copy.not-found' },
    });
    expect(r.revisions.size).toBe(0);
  });

  it('refuses an account without the key before anything is read', async () => {
    const denyAll: AuthorisationCheck = {
      check: () => Promise.resolve({ allowed: false, reason: 'missing-permission' } as never),
    };
    const r = rig(undefined, { gateOverride: denyAll });
    const product = newProduct();
    r.seed(product);
    const submitted = await r.useCase.execute(contextOf('admin'), request(product.state.id));
    expect(submitted.ok).toBe(false);
    expect(r.matched).toHaveLength(0);
    expect(r.revisions.size).toBe(0);
  });

  it('refuses when an attribute text matches, and stores nothing', async () => {
    const r = rig();
    const product = newProduct();
    r.seed(product, draft({ attributeValues: { note: { [locale]: 'halal note' } } }));
    const withAttribute = await r.useCase.execute(contextOf('admin'), request(product.state.id));
    expect(!withAttribute.ok && withAttribute.error).toMatchObject({
      code: 'claim-text.refused',
      fields: [{ field: 'product.attribute-text-value', ref: 'note', locale }],
    });
    expect(r.revisions.size).toBe(0);
  });

  it('refuses a name with a hidden character, naming the field and offset', async () => {
    const r = rig();
    const product = newProduct();
    r.seed(product, draft({ texts: { [locale]: { name: 'Da\u202Etes', description: 'ok' } } }));
    const submitted = await r.useCase.execute(contextOf('admin'), request(product.state.id));
    expect(!submitted.ok && submitted.error).toMatchObject({
      code: 'claim-text.refused',
      fields: [{ field: 'product.name', locale, code: 'text.invisible-character', offset: 2 }],
    });
    expect(r.revisions.size).toBe(0);
  });

  it('lists the placeholder refusal for every text, by field', async () => {
    const r = rig(unavailableClaimTextMatcher);
    const product = newProduct();
    r.seed(product);
    const submitted = await r.useCase.execute(contextOf('admin'), request(product.state.id));
    expect(!submitted.ok && submitted.error).toEqual({
      code: 'claim-text.refused',
      fields: [
        { field: 'product.name', ref: null, locale, code: 'claim-text.check-unavailable' },
        { field: 'product.description', ref: null, locale, code: 'claim-text.check-unavailable' },
      ],
    });
  });

  it('still publishes at once, and stores the reasons, when a sensitive field changes', async () => {
    const r = rig();
    const product = newProduct();
    r.seed(product);
    const first = await r.useCase.execute(contextOf('admin'), request(product.state.id));
    expect(first.ok).toBe(true);
    r.copies.set(product.state.id, {
      ...r.copies.get(product.state.id)!,
      content: draft({
        texts: { [locale]: { name: 'Fresh dates', description: 'Sweet and soft' } },
      }),
    });
    const second = await r.useCase.execute(contextOf('admin'), request(product.state.id));
    expect(second.ok && second.value.published).toBe(true);
    const revision = [...r.revisions.values()][1]!;
    expect(revision).toMatchObject({ sensitive: true, sensitiveReasons: ['name'] });
  });

  it('answers conflict.stale when the published revision cannot be read', async () => {
    const r = rig();
    const product = newProduct();
    r.seed(product);
    const first = await r.useCase.execute(contextOf('admin'), request(product.state.id));
    if (!first.ok) throw new Error('first');
    r.revisions.clear();
    const second = await r.useCase.execute(contextOf('admin'), request(product.state.id));
    expect(second).toEqual({ ok: false, error: { code: 'conflict.stale' } });
  });

  it('answers access.unavailable when the approval setting cannot be read', async () => {
    const r = rig(undefined, { approvalThrows: true });
    const product = newProduct();
    r.seed(product);
    const submitted = await r.useCase.execute(contextOf('admin'), request(product.state.id));
    expect(submitted).toEqual({ ok: false, error: { code: 'access.unavailable' } });
    expect(r.revisions.size).toBe(0);
  });

  it('returns the freeze failure when the family schema is not available', async () => {
    const r = rig(undefined, { noSchema: true });
    const product = newProduct();
    r.seed(product);
    const submitted = await r.useCase.execute(contextOf('admin'), request(product.state.id));
    expect(submitted).toEqual({ ok: false, error: { code: 'revision.schema-unavailable' } });
    expect(r.matched).toHaveLength(0);
    expect(r.revisions.size).toBe(0);
  });

  it('refuses a malformed request', async () => {
    const r = rig();
    const bad = await r.useCase.execute(contextOf('admin'), {
      productId: 'nope',
      replacePending: false,
    });
    expect(bad).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'productId', code: 'format' }] },
    });
    const flag = await r.useCase.execute(contextOf('admin'), {
      productId: ids.next<'Product'>(),
      replacePending: 'yes' as unknown as boolean,
    });
    expect(!flag.ok && flag.error.code).toBe('validation.failed');
  });
});
