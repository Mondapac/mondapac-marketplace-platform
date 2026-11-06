import { Temporal } from '@mondapac/shared-kernel';
import type {
  AuditEntry,
  CallContext,
  ContentHash,
  Id,
  MarketContext,
  MarketId,
  PendingEvent,
  Result,
} from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { activeTagState } from '../../../../../test/support/catalog-tag-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { Offer, type OfferState } from '../../domain/offer';
import type { OfferTagState } from '../../domain/offer-tag';
import { Product, type ProductState } from '../../domain/product';
import type { StoredRevision } from '../../domain/stored-revision';
import type { WorkingCopy } from '../../domain/working-copy';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { AllowedProductTypes } from '../ports/allowed-product-types.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import { AddSizes } from '../products/add-sizes.service';
import { OwnProductAddSizes } from './own-product-add-sizes.use-case';
import { PlatformProductAddSizes } from './platform-product-add-sizes.use-case';
import { PlatformProductAddSizesImpact } from './platform-product-add-sizes-impact.use-case';

// `own-product.add-sizes` and `platform-product.add-sizes` in memory (catalog design 4.2a, M-9;
// variants V9), on both Market fixtures: every guard in its order, the effects of the unit, the
// PLATFORM Offer set and the confirm. The database behaviour is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const realPolicy = new ConfigCatalogMarketPolicy(markets);
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-06T00:00:00Z');
const T1 = Temporal.Instant.from('2026-11-06T01:00:00Z');

const option = (code: string) => ({ code, labels: { en: code } });
const select = (code: string, options: string[]) => ({
  code,
  dataType: 'select' as const,
  localizable: false,
  required: false,
  isVariantOption: true,
  material: false,
  claimChecked: true as const,
  bounds: { options: options.map(option) },
});
const SCHEMA = {
  schemaRef: { familyCode: 'default', familyRevisionId: 'f1', definitionRevisionIds: [] },
  fields: [
    select('size', ['s', 'm', 'l']),
    select('colour', ['red', 'blue']),
    select('pattern', ['plain', 'striped']),
    select('finish', ['matt', 'gloss']),
  ],
};

describe.each(['AU', 'ZZ'] as const)('Add sizes in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T1);
  const ids = new SequenceIdGenerator(clock);
  const sellerId = ids.next<'Seller'>();
  const otherSellerId = ids.next<'Seller'>();
  const productId = ids.next<'Product'>();
  const publishedId = ids.next<'ProductRevision'>();
  const pendingId = ids.next<'ProductRevision'>();
  const variantId = ids.next<'Variant'>();
  const locale = realPolicy.locales(market).default;
  const taxCode = realPolicy.taxCategoryCodes(market)[0]!;
  const maxAxes = realPolicy.maxVariantAttributes(market);

  const contextOf = (population: 'seller' | 'admin', forSeller: Id<'Seller'> | null) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: forSeller,
      }),
    );
  const sellerContext = (): CallContext => contextOf('seller', sellerId);
  const adminContext = (): CallContext => contextOf('admin', null);

  const productState = (overrides: Partial<ProductState> = {}): ProductState => ({
    id: productId,
    marketId: code as MarketId,
    scope: 'SELLER',
    ownerSellerId: sellerId,
    createdBySellerId: sellerId,
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
    version: 5,
    createdAt: T0,
    variants: [
      {
        id: variantId,
        variantNo: 1,
        state: 'published',
        createdAt: T0,
        publishedAt: T0,
        retiredAt: null,
      },
    ],
    publishedRevisionId: publishedId,
    pendingRevisionId: null,
    pendingSubmittedAt: null,
    ...overrides,
  });
  const platformState = (overrides: Partial<ProductState> = {}): ProductState =>
    productState({ scope: 'PLATFORM', ownerSellerId: null, createdBySellerId: null, ...overrides });
  const pendingState = (overrides: Partial<ProductState> = {}): ProductState =>
    productState({ pendingRevisionId: pendingId, pendingSubmittedAt: T0, ...overrides });

  const revisionOf = (id: Id<'ProductRevision'> = publishedId): StoredRevision => ({
    id,
    productId,
    revisionNo: 1,
    typeCode: 'simple',
    kind: 'submission',
    baseRevisionId: null,
    revertedFromRevisionId: null,
    sensitive: false,
    sensitiveReasons: [],
    contentHash: 'sha256:aaaa' as ContentHash,
    authorKind: 'seller',
    authorAccountId: ids.next<'Account'>(),
    actingAdminAccountId: null,
    submittedAt: T0,
    content: {
      texts: { [locale]: { name: 'Shirt', shortDescription: null, description: null } },
      categoryIds: ['c1'],
      taxCategoryCode: taxCode,
      attributeValues: {},
      variants: [
        {
          variantId,
          position: 1,
          optionKey: '',
          optionValues: {},
          labels: {},
          gtin: null,
          shippingWeightGrams: null,
          shippingLengthMm: null,
          shippingWidthMm: null,
          shippingHeightMm: null,
          imageIds: [],
        },
      ],
      imageIds: [],
      schemaRef: { familyRevisionId: 'f1', definitionRevisionIds: [] },
      contentSchemaVersion: 1,
    },
  });

  const offerState = (
    offerSeller: Id<'Seller'>,
    overrides: Partial<OfferState> = {},
  ): OfferState => ({
    id: ids.next<'Offer'>(),
    marketId: code as MarketId,
    sellerId: offerSeller,
    productId,
    sellerSku: `SKU-${offerSeller.slice(-6)}`,
    conditionCode: 'new',
    description: {},
    handling: 'SEALED_ORIGINAL',
    attestationRecordedAt: null,
    attestationAccountId: null,
    status: 'published',
    offSaleCauses: [],
    listed: true,
    submittedAt: T0,
    firstPublishedAt: T0,
    deletedAt: null,
    version: 3,
    createdAt: T0,
    ...overrides,
  });

  interface RigOptions {
    product?: ProductState | null;
    copy?: WorkingCopy | null;
    published?: StoredRevision | null;
    offers?: { state: OfferState; tags?: OfferTagState[] }[];
    /** Per seller; absent is `all`; `null` is an error of the reader. */
    allowed?: Map<Id<'Seller'>, AllowedProductTypes | null>;
    eligible?: boolean;
    policy?: Partial<CatalogMarketPolicy>;
    family?: string;
    schema?: null;
    lockFails?: boolean;
    /** The Offers the unit reads, from its second read of them (a seller joined in between). */
    laterOffers?: { state: OfferState; tags?: OfferTagState[] }[];
    rateCount?: number;
    rateDown?: boolean;
  }

  function rig(options: RigOptions = {}) {
    let state = options.product === undefined ? productState() : options.product;
    let copy = options.copy === undefined ? null : options.copy;
    const published = options.published === undefined ? revisionOf() : options.published;
    const saved: Product[] = [];
    const copies: WorkingCopy[] = [];
    const events: PendingEvent[] = [];
    const audits: AuditEntry[] = [];
    const savedOffers: Offer[] = [];
    const offerReads: number[] = [];
    let locks = 0;
    let reserved = 0;
    let offerListings = 0;
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const products = {
      findById: (m: MarketContext) =>
        Promise.resolve(
          state === null || state.marketId !== m.marketId ? null : Product.restore(state),
        ),
      save: (_m: MarketContext, product: Product) => {
        saved.push(product);
        state = product.state;
        return Promise.resolve();
      },
      lockAtVersion: () => {
        locks += 1;
        return Promise.resolve(options.lockFails !== true);
      },
    } as never;
    const workingCopies = {
      find: () => Promise.resolve(copy),
      save: (_m: MarketContext, next: WorkingCopy) => {
        copies.push(next);
        copy = next;
        return Promise.resolve();
      },
    } as never;
    const revisions = {
      find: () => Promise.resolve(published),
    } as never;
    const offersOf = () => {
      offerReads.push(1);
      const rows =
        offerReads.length > 1 && options.laterOffers ? options.laterOffers : options.offers;
      return (rows ?? []).map((row) => Offer.restore(row.state, row.tags ?? []));
    };
    const offers = {
      listOnProduct: (_m: MarketContext, _p: unknown, page: { afterId: unknown }) =>
        Promise.resolve(page.afterId === null ? offersOf() : []),
      save: (_m: MarketContext, offer: Offer) => {
        savedOffers.push(offer);
        offerListings += offer.pendingEvents.filter(
          (event) => event.type === 'catalog.offer-listing-changed.v1',
        ).length;
        return Promise.resolve(null);
      },
    } as never;
    const offerFinder = {
      findOwnOnProduct: () => {
        const row = options.offers?.[0];
        return Promise.resolve(row === undefined ? null : Offer.restore(row.state, row.tags ?? []));
      },
    };
    // The synthetic Market lists only `simple`; Add sizes needs Configurable listed, so the rig
    // lists both unless a test says otherwise.
    const policy = Object.assign(
      Object.create(realPolicy) as CatalogMarketPolicy,
      { productTypes: () => ['simple', 'configurable'] },
      options.policy,
    );
    const service = new AddSizes({
      unitOfWork,
      products,
      workingCopies,
      revisions,
      offers,
      offerFinder,
      attributes: {
        loadSchema: () => Promise.resolve(options.schema === null ? null : SCHEMA),
        familyCodeOfRevision: () => Promise.resolve('default'),
      } as never,
      familyResolver: {
        resolve: () => Promise.resolve({ ok: true, familyCode: options.family ?? 'default' }),
      } as never,
      policy,
      allowedTypes: {
        allowedFor: (_c: CallContext, seller: Id<'Seller'>) =>
          Promise.resolve(options.allowed?.has(seller) ? options.allowed.get(seller)! : 'all'),
      },
      counters: {
        reserve: (_m: MarketContext, counters: readonly { limit: { kind: string } }[]) => {
          if (options.rateDown === true) return Promise.reject(new Error('counter store down'));
          reserved += 1;
          return Promise.resolve(
            counters.map((counter) => ({
              kind: counter.limit.kind,
              count: options.rateCount ?? 1,
              windowStartedAt: T0,
            })),
          );
        },
        purgeStartedBefore: () => Promise.resolve(0),
      } as never,
      counterKeys: { keyOf: () => new Uint8Array(32) },
      outbox: {
        append: (_c: CallContext, pending: readonly PendingEvent[]) => {
          events.push(...pending);
          return Promise.resolve();
        },
      },
      audit: {
        record: (_c: CallContext, entry: AuditEntry) => {
          audits.push(entry);
          return Promise.resolve();
        },
      },
      clock,
    });
    const own = new OwnProductAddSizes(gate, {
      addSizes: service,
      eligibility: { isEligible: () => Promise.resolve(options.eligible ?? true) },
    });
    const platform = new PlatformProductAddSizes(gate, { addSizes: service });
    const impact = new PlatformProductAddSizesImpact(gate, { addSizes: service });
    return {
      own,
      platform,
      impact,
      saved,
      copies,
      events,
      audits,
      savedOffers,
      locks: () => locks,
      reserved: () => reserved,
      offerListings: () => offerListings,
      state: () => state,
    };
  }

  const body = (overrides: Record<string, unknown> = {}) => ({
    version: 5,
    axes: ['size'],
    optionValues: { size: 'm' },
    replacePending: false,
    ...overrides,
  });
  const platformBody = (overrides: Record<string, unknown> = {}) =>
    body({ offOfferCount: 0, ...overrides });
  const types = (events: readonly PendingEvent[]): string[] => events.map((event) => event.type);

  describe('own-product.add-sizes', () => {
    it('turns a published Simple product into a Configurable one and writes the working copy', async () => {
      const harness = rig();
      const result = await harness.own.execute(sellerContext(), {
        productId,
        body: body(),
      });

      expect(result).toEqual({
        ok: true,
        value: {
          productId,
          variantId,
          version: 6,
          offOfferCount: 0,
          supersededRevisionId: null,
        },
      });
      expect(harness.state()).toMatchObject({
        typeCode: 'configurable',
        variantModel: 'options',
        publishedRevisionId: publishedId,
        status: 'published',
        version: 6,
      });
      // The working copy is made from the published revision, then gets the axes and the options.
      expect(harness.copies).toHaveLength(1);
      expect(harness.copies[0]).toMatchObject({
        productId,
        baseRevisionId: publishedId,
        lastSavedAt: T1,
        content: {
          texts: { [locale]: { name: 'Shirt' } },
          categoryIds: ['c1'],
          taxCategoryCode: taxCode,
          variantAxes: ['size'],
          variants: [{ variantId, optionValues: { size: 'm' } }],
        },
      });
      expect(types(harness.events)).toEqual(['catalog.product-type-changed.v1']);
      expect(harness.events[0]).toMatchObject({
        aggregateVersion: 6,
        payload: {
          productId,
          scope: 'seller',
          fromTypeCode: 'simple',
          toTypeCode: 'configurable',
          variantId,
          publishedRevisionId: publishedId,
        },
      });
      expect(harness.audits).toHaveLength(1);
      expect(harness.audits[0]).toMatchObject({
        action: 'catalog.product.type-changed',
        targetId: productId,
        before: { typeCode: 'simple' },
        after: { typeCode: 'configurable', scope: 'seller', offOfferCount: 0, axisCount: 1 },
      });
      expect(harness.reserved()).toBe(1);
      expect(harness.locks()).toBe(0);
    });

    it('adds the axes to the draft the seller already has and keeps everything else in it', async () => {
      const copy: WorkingCopy = {
        productId,
        content: {
          texts: { [locale]: { name: 'Shirt, edited' } },
          categoryIds: ['c9'],
          variants: [{ variantId, gtin: '09506000134352' }],
        },
        contentSchemaVersion: 1,
        baseRevisionId: publishedId,
        lastSavedAt: T0,
        lastSavedByAccountId: ids.next<'Account'>(),
      };
      const harness = rig({ copy });
      const result = await harness.own.execute(sellerContext(), {
        productId,
        body: body({ axes: ['size', 'colour'], optionValues: { size: 'l', colour: 'red' } }),
      });

      expect(result.ok).toBe(true);
      expect(harness.copies[0]?.content).toEqual({
        texts: { [locale]: { name: 'Shirt, edited' } },
        categoryIds: ['c9'],
        variantAxes: ['size', 'colour'],
        variants: [
          { variantId, gtin: '09506000134352', optionValues: { size: 'l', colour: 'red' } },
        ],
      });
      expect(harness.copies[0]?.baseRevisionId).toBe(publishedId);
    });

    it('starts the working copy of a product never published with the axes alone', async () => {
      const harness = rig({
        product: productState({
          status: 'draft',
          publishedRevisionId: null,
          variants: [
            {
              id: variantId,
              variantNo: 1,
              state: 'proposed',
              createdAt: T0,
              publishedAt: null,
              retiredAt: null,
            },
          ],
        }),
        published: null,
      });
      const result = await harness.own.execute(sellerContext(), { productId, body: body() });

      expect(result.ok).toBe(true);
      expect(harness.copies[0]).toMatchObject({
        baseRevisionId: null,
        content: { variantAxes: ['size'], variants: [{ variantId, optionValues: { size: 'm' } }] },
      });
      expect(harness.events[0]).toMatchObject({ payload: { publishedRevisionId: null } });
    });

    it.each([
      ['an id that is not one', { id: 'nope' }, 'product.not-found'],
      [
        'a product of another seller',
        { product: productState({ ownerSellerId: otherSellerId }) },
        'product.not-found',
      ],
      ['a PLATFORM product', { product: platformState() }, 'product.not-found'],
      ['an unknown product', { product: null }, 'product.not-found'],
      [
        'a discarded product',
        {
          product: productState({
            status: 'discarded',
            discardedAt: T0,
            publishedRevisionId: null,
          }),
        },
        'product.not-editable',
      ],
      [
        'a Configurable product',
        { product: productState({ typeCode: 'configurable', variantModel: 'options' }) },
        'product.not-simple',
      ],
      [
        'a pending revision without replacePending',
        { product: pendingState() },
        'revision.pending-exists',
      ],
      ['a seller who may not sell', { eligible: false }, 'seller.not-eligible'],
      [
        'a Market that lists no Configurable type',
        { policy: { productTypes: () => ['simple'] } },
        'product-type.not-allowed',
      ],
      [
        'an owner whose allowed types leave Configurable out',
        { allowed: new Map([[sellerId, new Set(['simple'])]]) },
        'product-type.not-allowed',
      ],
      [
        'an owner with no allowed types at all',
        { allowed: new Map([[sellerId, new Set<string>()]]) },
        'product-type.not-allowed',
      ],
      [
        'a reader that fails (fail closed)',
        { allowed: new Map([[sellerId, null]]) },
        'access.unavailable',
      ],
      ['a feature set that cannot be read', { schema: null }, 'revision.schema-unavailable'],
      ['a version the page did not read', { input: { version: 4 } }, 'conflict.stale'],
    ] as const)('refuses %s with %s and writes nothing', async (_name, change, expected) => {
      const options = change as RigOptions & { id?: string; input?: Record<string, unknown> };
      const harness = rig(options);
      const result = await harness.own.execute(sellerContext(), {
        productId: options.id ?? productId,
        body: body(options.input),
      });

      expect(result).toMatchObject({ ok: false, error: { code: expected } });
      expect(harness.saved).toEqual([]);
      expect(harness.copies).toEqual([]);
      expect(harness.events).toEqual([]);
      expect(harness.audits).toEqual([]);
    });

    it('answers the guards in the order of design 4.2a', async () => {
      // Not Simple beats the pending guard, the SEL-12 guard and the axes guard.
      const configurablePending = rig({
        product: pendingState({ typeCode: 'configurable', variantModel: 'options' }),
        allowed: new Map([[sellerId, new Set<string>()]]),
      });
      expect(
        await configurablePending.own.execute(sellerContext(), {
          productId,
          body: body({ axes: [] }),
        }),
      ).toMatchObject({ error: { code: 'product.not-simple' } });
      // The pending guard beats SEL-12 and the axes guard.
      const pending = rig({
        product: pendingState(),
        allowed: new Map([[sellerId, new Set<string>()]]),
      });
      expect(
        await pending.own.execute(sellerContext(), { productId, body: body({ axes: [] }) }),
      ).toMatchObject({ error: { code: 'revision.pending-exists' } });
      // SEL-12 beats the axes guard, and the axes guard beats the version.
      const sel12 = rig({ allowed: new Map([[sellerId, new Set<string>()]]) });
      expect(
        await sel12.own.execute(sellerContext(), { productId, body: body({ axes: [] }) }),
      ).toMatchObject({ error: { code: 'product-type.not-allowed' } });
      const axes = rig();
      expect(
        await axes.own.execute(sellerContext(), {
          productId,
          body: body({ axes: [], version: 1 }),
        }),
      ).toMatchObject({ error: { code: 'validation.failed' } });
    });

    it.each([
      [
        'no axis',
        { axes: [], optionValues: {} },
        [{ path: 'variantAxes', code: 'variants.axes-none' }],
      ],
      [
        'an axis twice',
        { axes: ['size', 'size'] },
        [{ path: 'variantAxes', code: 'variants.axes-duplicate' }],
      ],
      [
        'an axis the feature set does not hold',
        { axes: ['weight'] },
        [{ path: 'variantAxes', code: 'variants.axes-unknown' }],
      ],
      [
        'more axes than the Market allows',
        {
          axes: ['size', 'colour', 'pattern', 'finish'].slice(0, maxAxes + 1),
          optionValues: { size: 's', colour: 'red', pattern: 'plain', finish: 'matt' },
        },
        [{ path: 'variantAxes', code: 'variants.axes-too-many' }],
      ],
      [
        'an axis without an option value',
        { axes: ['size', 'colour'], optionValues: { size: 'm' } },
        [{ path: 'optionValues', code: 'variants.option-missing' }],
      ],
      [
        'an option the axis does not hold',
        { optionValues: { size: 'xxl' } },
        [{ path: 'optionValues', code: 'variants.option-unknown' }],
      ],
      [
        'an option value of a field that is not an axis',
        { optionValues: { size: 'm', colour: 'red' } },
        [{ path: 'optionValues', code: 'variants.option-unknown' }],
      ],
    ] as const)('refuses %s with validation.failed', async (_name, input, fields) => {
      const harness = rig();
      const result = await harness.own.execute(sellerContext(), {
        productId,
        body: body(input),
      });

      expect(result).toEqual({ ok: false, error: { code: 'validation.failed', fields } });
      expect(harness.saved).toEqual([]);
      expect(harness.copies).toEqual([]);
    });

    it('names an axis the new feature set lacks as not in the family (the primary category moved)', async () => {
      const harness = rig({ family: 'other' });
      const result = await harness.own.execute(sellerContext(), {
        productId,
        body: body({ axes: ['weight'] }),
      });
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [{ path: 'variantAxes', code: 'variants.option-not-in-family' }],
        },
      });
    });

    it.each([
      ['a body that is not an object', 'x', 'body'],
      ['a version that is not a positive whole number', body({ version: 0 }), 'version'],
      ['axes that are not a list', body({ axes: 'size' }), 'axes'],
      ['an axis that is not a code', body({ axes: ['size '] }), 'axes'],
      ['option values that are a list', body({ optionValues: ['m'] }), 'optionValues'],
      ['an option value that is not a code', body({ optionValues: { size: 3 } }), 'optionValues'],
      ['a prototype key', body({ optionValues: JSON.parse('{"__proto__":"m"}') }), 'optionValues'],
      ['a replacePending that is not a boolean', body({ replacePending: 'yes' }), 'replacePending'],
      ['a confirmed count a seller does not send', body({ offOfferCount: 0 }), 'offOfferCount'],
    ])('refuses %s before it reads anything', async (_name, request, path) => {
      const harness = rig();
      const result = await harness.own.execute(sellerContext(), { productId, body: request });

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path }] },
      });
      expect(harness.reserved()).toBe(0);
      expect(harness.saved).toEqual([]);
    });

    it('spends one of 20 an hour first, and answers a spent limit with the wait', async () => {
      const throttled = rig({ rateCount: 21 });
      expect(await throttled.own.execute(sellerContext(), { productId, body: body() })).toEqual({
        ok: false,
        error: { code: 'request.throttled', retryAfterSeconds: 1 },
      });
      expect(throttled.saved).toEqual([]);
      const atLimit = rig({ rateCount: 20 });
      expect((await atLimit.own.execute(sellerContext(), { productId, body: body() })).ok).toBe(
        true,
      );
      const down = rig({ rateDown: true });
      expect(await down.own.execute(sellerContext(), { productId, body: body() })).toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
      expect(down.saved).toEqual([]);
    });

    it('refuses an admin, an anonymous caller and a seller actor without a seller id', async () => {
      const harness = rig();
      expect(await harness.own.execute(adminContext(), { productId, body: body() })).toMatchObject({
        error: { code: 'access.denied' },
      });
      expect(harness.saved).toEqual([]);
    });

    describe('a pending revision', () => {
      const pendingTag = (revisionId: Id<'ProductRevision'>): OfferTagState =>
        activeTagState(
          ids.next<'OfferTag'>(),
          'halal',
          {
            certificateId: ids.next(),
            versionId: ids.next(),
            typeRevisionId: ids.next(),
          },
          T0,
          {
            status: 'pending-publish',
            badge: null,
            copyRevisionId: revisionId,
            copyRevisionPublished: false,
          },
        );

      it('is set aside with replacePending: the pointer clears and the family goes back', async () => {
        const harness = rig({ product: pendingState({ familyCode: 'other' }) });
        const result = await harness.own.execute(sellerContext(), {
          productId,
          body: body({ replacePending: true }),
        });

        expect(result).toMatchObject({
          ok: true,
          value: { supersededRevisionId: pendingId, version: 7 },
        });
        expect(harness.state()).toMatchObject({
          pendingRevisionId: null,
          pendingSubmittedAt: null,
          publishedRevisionId: publishedId,
          familyCode: 'default',
          typeCode: 'configurable',
        });
        expect(types(harness.events)).toEqual([
          'catalog.product-type-changed.v1',
          'catalog.product-family-changed.v1',
        ]);
        // A published product's Offer keeps its tags: nothing names a revision that never publishes.
        expect(harness.savedOffers).toEqual([]);
      });

      it('clears the pending-publish tags of the owner Offer of a product never published', async () => {
        const state = offerState(sellerId, { status: 'draft', listed: false });
        const harness = rig({
          product: pendingState({ status: 'unpublished', publishedRevisionId: null }),
          published: null,
          offers: [{ state, tags: [pendingTag(pendingId)] }],
        });
        const result = await harness.own.execute(sellerContext(), {
          productId,
          body: body({ replacePending: true }),
        });

        expect(result.ok).toBe(true);
        expect(harness.savedOffers).toHaveLength(1);
        expect(harness.savedOffers[0]!.tags.filter((tag) => tag.status !== 'removed')).toEqual([]);
        expect(harness.state()).toMatchObject({ pendingRevisionId: null, familyCode: 'default' });
        expect(harness.audits[0]).toMatchObject({ after: { offerCount: 1 } });
      });

      it('leaves the Offer alone when it holds no pending-publish tag', async () => {
        const harness = rig({
          product: pendingState({ status: 'unpublished', publishedRevisionId: null }),
          published: null,
          offers: [{ state: offerState(sellerId, { status: 'draft', listed: false }) }],
        });
        expect(
          (
            await harness.own.execute(sellerContext(), {
              productId,
              body: body({ replacePending: true }),
            })
          ).ok,
        ).toBe(true);
        expect(harness.savedOffers).toEqual([]);
      });
    });
  });

  describe('platform-product.add-sizes', () => {
    const buyerSeller = ids.next<'Seller'>();
    const tinySeller = ids.next<'Seller'>();
    const allowed = new Map<Id<'Seller'>, AllowedProductTypes | null>([
      [otherSellerId, 'all'],
      [buyerSeller, new Set(['simple'])],
      [tinySeller, new Set<string>()],
    ]);
    const offersOf = () => [
      { state: offerState(otherSellerId) },
      { state: offerState(buyerSeller) },
      { state: offerState(tinySeller, { status: 'draft', listed: false }) },
    ];

    it('changes the type and takes the Offers of sellers who may not sell it off sale', async () => {
      const harness = rig({ product: platformState(), offers: offersOf(), allowed });
      const result = await harness.platform.execute(adminContext(), {
        productId,
        body: platformBody({ offOfferCount: 2 }),
      });

      expect(result).toEqual({
        ok: true,
        value: { productId, variantId, version: 6, offOfferCount: 2, supersededRevisionId: null },
      });
      expect(harness.locks()).toBe(1);
      expect(harness.savedOffers.map((offer) => offer.state.sellerId).sort()).toEqual(
        [buyerSeller, tinySeller].sort(),
      );
      for (const offer of harness.savedOffers) {
        expect(offer.state.offSaleCauses).toEqual(['type-not-allowed']);
        expect(offer.state.listed).toBe(false);
      }
      // Only the published Offer was listed, so only it announces going off sale.
      expect(harness.offerListings()).toBe(1);
      expect(types(harness.events).filter((type) => type.startsWith('catalog.offer'))).toEqual([
        'catalog.offer-listing-changed.v1',
      ]);
      expect(
        harness.events.find((e) => e.type === 'catalog.product-type-changed.v1'),
      ).toMatchObject({
        payload: { scope: 'platform', variantId },
      });
      expect(harness.audits[0]).toMatchObject({
        after: { scope: 'platform', offerCount: 3, offOfferCount: 2 },
      });
    });

    it('changes the type of a product whose sellers may all sell it, and takes nothing off sale', async () => {
      const harness = rig({
        product: platformState(),
        offers: [{ state: offerState(otherSellerId) }],
        allowed,
      });
      const result = await harness.platform.execute(adminContext(), {
        productId,
        body: platformBody(),
      });
      expect(result).toMatchObject({ ok: true, value: { offOfferCount: 0 } });
      expect(harness.savedOffers).toEqual([]);
    });

    it('answers a count that moved with the current one and writes nothing', async () => {
      const harness = rig({ product: platformState(), offers: offersOf(), allowed });
      const result = await harness.platform.execute(adminContext(), {
        productId,
        body: platformBody({ offOfferCount: 1 }),
      });

      expect(result).toEqual({
        ok: false,
        error: { code: 'confirm.count-changed', currentCount: 2 },
      });
      expect(harness.saved).toEqual([]);
      expect(harness.copies).toEqual([]);
      expect(harness.savedOffers).toEqual([]);
    });

    it('fails closed when the allowed types of any seller cannot be read', async () => {
      const harness = rig({
        product: platformState(),
        offers: offersOf(),
        allowed: new Map([...allowed, [tinySeller, null]]),
      });
      const result = await harness.platform.execute(adminContext(), {
        productId,
        body: platformBody({ offOfferCount: 2 }),
      });
      expect(result).toEqual({ ok: false, error: { code: 'access.unavailable' } });
      expect(harness.saved).toEqual([]);
    });

    it('answers conflict.stale when the sellers with an Offer differ after the lock', async () => {
      const harness = rig({
        product: platformState(),
        offers: offersOf(),
        laterOffers: [...offersOf(), { state: offerState(ids.next<'Seller'>()) }],
        allowed,
      });
      const result = await harness.platform.execute(adminContext(), {
        productId,
        body: platformBody({ offOfferCount: 2 }),
      });
      expect(result).toEqual({ ok: false, error: { code: 'conflict.stale' } });
      expect(harness.locks()).toBe(1);
      expect(harness.saved).toEqual([]);
      expect(harness.savedOffers).toEqual([]);
    });

    it('answers conflict.stale when the product row moved before the lock', async () => {
      const harness = rig({ product: platformState(), lockFails: true });
      expect(
        await harness.platform.execute(adminContext(), { productId, body: platformBody() }),
      ).toEqual({ ok: false, error: { code: 'conflict.stale' } });
    });

    it('checks the count before the version', async () => {
      const harness = rig({ product: platformState(), offers: offersOf(), allowed });
      expect(
        await harness.platform.execute(adminContext(), {
          productId,
          body: platformBody({ offOfferCount: 9, version: 1 }),
        }),
      ).toMatchObject({ error: { code: 'confirm.count-changed', currentCount: 2 } });
      expect(
        await harness.platform.execute(adminContext(), {
          productId,
          body: platformBody({ offOfferCount: 2, version: 1 }),
        }),
      ).toEqual({ ok: false, error: { code: 'conflict.stale' } });
    });

    it('refuses a SELLER product, a seller caller and a body without the confirmed count', async () => {
      const harness = rig();
      expect(
        await harness.platform.execute(adminContext(), { productId, body: platformBody() }),
      ).toMatchObject({ error: { code: 'product.seller-only' } });
      expect(
        await harness.platform.execute(sellerContext(), { productId, body: platformBody() }),
      ).toMatchObject({ error: { code: 'access.denied' } });
      const platform = rig({ product: platformState() });
      expect(
        await platform.platform.execute(adminContext(), { productId, body: body() }),
      ).toMatchObject({
        error: { code: 'validation.failed', fields: [{ path: 'offOfferCount' }] },
      });
      expect(platform.reserved()).toBe(0);
    });

    it('sets a pending revision aside only with replacePending, as a seller does', async () => {
      const harness = rig({
        product: platformState({ pendingRevisionId: pendingId, pendingSubmittedAt: T0 }),
      });
      expect(
        await harness.platform.execute(adminContext(), { productId, body: platformBody() }),
      ).toMatchObject({ error: { code: 'revision.pending-exists' } });
    });

    it('reads the confirm: how many Offers would go off sale, and the version to send back', async () => {
      const harness = rig({ product: platformState(), offers: offersOf(), allowed });
      expect(await harness.impact.execute(adminContext(), { productId })).toEqual({
        ok: true,
        value: { productId, version: 5, offOfferCount: 2 },
      });
      expect(harness.reserved()).toBe(0);
      expect(harness.saved).toEqual([]);
      expect(
        await rig({
          product: platformState(),
          offers: offersOf(),
          allowed: new Map([...allowed, [buyerSeller, null]]),
        }).impact.execute(adminContext(), { productId }),
      ).toEqual({ ok: false, error: { code: 'access.unavailable' } });
      expect(await rig().impact.execute(adminContext(), { productId })).toMatchObject({
        error: { code: 'product.seller-only' },
      });
      expect(
        await rig({ product: null }).impact.execute(adminContext(), { productId }),
      ).toMatchObject({
        error: { code: 'product.not-found' },
      });
      expect(await harness.impact.execute(sellerContext(), { productId })).toMatchObject({
        error: { code: 'access.denied' },
      });
    });
  });
});
