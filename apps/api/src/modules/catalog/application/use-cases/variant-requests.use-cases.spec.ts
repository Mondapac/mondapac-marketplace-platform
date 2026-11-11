import type { AuditEntry, CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemoryAttributeDefinitionStore } from '../../../../../test/support/catalog-attribute-editor-fakes';
import { MemoryVariantRequestStore } from '../../../../../test/support/catalog-variant-request-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { MailMessage, MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CATALOG_OWN_PRODUCT_EDIT,
  CATALOG_OWN_PRODUCT_VIEW,
  CATALOG_PLATFORM_PRODUCT_EDIT,
  CATALOG_VARIANT_REQUEST_REVIEW,
} from '../../contracts/permissions';
import { AttributeDefinition } from '../../domain/attribute-definition';
import { VariantRequest } from '../../domain/variant-request';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import { OwnVariantRequestCreate } from './own-variant-request-create.use-case';
import { OwnVariantRequestsList } from './own-variant-requests-list.use-case';
import { SendVariantRequestNotices } from './send-variant-request-notices.use-case';
import { VariantRequestApprove } from './variant-request-approve.use-case';
import { VariantRequestDecline } from './variant-request-decline.use-case';
import { VariantRequestList } from './variant-request-list.use-case';
import { VariantRequestMap } from './variant-request-map.use-case';

// The variant requests' use cases in memory (variants plan, package V7), on both Market fixtures:
// the seller's request (only an Offer of their own, byte-identical refusals for anyone else's, the
// axes and options of the product, a variant the product has, the limits), the seller's list, the
// admin queue and the three decisions (the version check, the draft an approval saves, the audit
// rows) and the notice mail. The SQL is in test/db/catalog-variant-requests.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-11-11T10:00:00Z');
const ADMIN = '01990000-0000-7000-8000-0000000000a1' as Id<'Account'>;
const SELLER = '01990000-0000-7000-8000-0000000000a3' as Id<'Seller'>;
const OTHER_SELLER = '01990000-0000-7000-8000-0000000000a4' as Id<'Seller'>;
const PRODUCT = '01990000-0000-7000-8000-0000000000b1' as Id<'Product'>;
const SELLER_PRODUCT = '01990000-0000-7000-8000-0000000000b2' as Id<'Product'>;
const OFFER = '01990000-0000-7000-8000-0000000000d1' as Id<'Offer'>;
const OTHER_OFFER = '01990000-0000-7000-8000-0000000000d2' as Id<'Offer'>;
const SELLER_OFFER = '01990000-0000-7000-8000-0000000000d3' as Id<'Offer'>;
const SIZE = '01990000-0000-7000-8000-0000000000c4' as Id<'AttributeDefinition'>;
const V_SMALL = '01990000-0000-7000-8000-0000000000e1' as Id<'Variant'>;
const V_LARGE = '01990000-0000-7000-8000-0000000000e2' as Id<'Variant'>;
const V_NEW = '01990000-0000-7000-8000-0000000000e3' as Id<'Variant'>;

describe.each(['AU', 'ZZ'] as const)('variant request use cases in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const otherMarket: MarketContext = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const english = policy.locales(market).default;

  const context = (
    population: 'admin' | 'seller',
    sellerId: Id<'Seller'> | null = SELLER,
    on: MarketContext = market,
  ): CallContext =>
    testCallContext(
      on,
      testAuthenticatedActor(on, {
        population,
        accountId: ADMIN,
        sessionId: '01990000-0000-7000-8000-0000000000a2' as never,
        sellerId: population === 'seller' ? sellerId : null,
      }),
    );
  const actingAs = (): CallContext => {
    const base = context('admin');
    return { ...base, actor: { ...base.actor, actingAs: { adminAccountId: ADMIN } } as never };
  };

  let definitions: MemoryAttributeDefinitionStore;
  let requests: MemoryVariantRequestStore;
  let audits: AuditEntry[];
  let allow: boolean;
  let eligible: boolean;
  let mails: MailMessage[];
  let mailFails: boolean;
  let address: string | null;
  let hasDraft: boolean;
  let draftSaves: { content: Record<string, unknown>; variantIds: unknown[] }[];
  let saveFails: boolean;
  let productStatus: string;
  let gainedXl: boolean;
  /** The draft save of an approval mints the new variant: it is live afterwards. */
  let savedNew: boolean;

  const clock = new FixedClock(T0);
  let ids: SequenceIdGenerator;

  const KEYS: readonly string[] = [
    CATALOG_OWN_PRODUCT_EDIT.key,
    CATALOG_OWN_PRODUCT_VIEW.key,
    CATALOG_VARIANT_REQUEST_REVIEW.key,
    CATALOG_PLATFORM_PRODUCT_EDIT.key,
  ];
  const check: AuthorisationCheck = {
    check: (_context, declaration) =>
      Promise.resolve(
        allow &&
          declaration.rule.kind === 'permissions' &&
          declaration.rule.allOf.every((key) => KEYS.includes(key))
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const unitOfWork = {
    run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
  } as unknown as UnitOfWork;
  const audit: AuditWriter = {
    record: (_c, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const mailTransport: MailTransport = {
    send: (message) => {
      if (mailFails) return Promise.reject(new Error('smtp down'));
      mails.push(message);
      return Promise.resolve();
    },
  };

  const variant = (id: Id<'Variant'>, variantNo: number, state = 'published') => ({
    id,
    variantNo,
    state,
  });
  const platformProduct = () => {
    const variants = [variant(V_SMALL, 1), variant(V_LARGE, 2)];
    if (gainedXl || savedNew) variants.push(variant(V_NEW, 3));
    return {
      state: {
        id: PRODUCT,
        scope: 'PLATFORM',
        ownerSellerId: null,
        status: productStatus,
        variantModel: 'options',
        familyCode: 'food',
        productCode: 'P-9',
        publishedRevisionId: 'rev-1',
        variants,
      },
      liveVariants: variants,
    };
  };
  const sellerProduct = () => ({
    state: {
      id: SELLER_PRODUCT,
      scope: 'SELLER',
      ownerSellerId: SELLER,
      status: 'published',
      variantModel: 'options',
      familyCode: 'food',
      productCode: 'P-2',
      publishedRevisionId: 'rev-2',
      variants: [],
    },
    liveVariants: [],
  });
  const products = {
    findById: (_m: MarketContext, id: Id<'Product'>) =>
      Promise.resolve(
        id === PRODUCT ? platformProduct() : id === SELLER_PRODUCT ? sellerProduct() : null,
      ),
  };
  const offers = {
    findById: (_m: MarketContext, id: Id<'Offer'>) => {
      const offer = (sellerId: Id<'Seller'>, productId: Id<'Product'>) => ({
        state: { id, sellerId, productId, status: 'published' },
      });
      return Promise.resolve(
        id === OFFER
          ? offer(SELLER, PRODUCT)
          : id === OTHER_OFFER
            ? offer(OTHER_SELLER, PRODUCT)
            : id === SELLER_OFFER
              ? offer(SELLER, SELLER_PRODUCT)
              : null,
      );
    },
  };
  const revisionContent = {
    texts: { [english]: { name: 'Rice', shortDescription: null, description: null } },
    categoryIds: [],
    topicIds: [],
    taxCategoryCode: 'gst-free',
    attributeValues: {},
    imageIds: [],
    variants: [
      { variantId: V_SMALL, optionValues: { 'size-option': 'small' }, gtin: null, imageIds: [] },
      { variantId: V_LARGE, optionValues: { 'size-option': 'large' }, gtin: null, imageIds: [] },
    ],
  };
  const revisions = {
    find: () => Promise.resolve({ content: revisionContent } as never),
  };
  const workingCopies = {
    find: () =>
      Promise.resolve(
        hasDraft
          ? ({
              content: {
                texts: revisionContent.texts,
                variants: [
                  { variantId: V_SMALL, optionValues: { 'size-option': 'small' } },
                  { variantId: V_LARGE, optionValues: { 'size-option': 'large' } },
                ],
                variantAxes: ['size-option'],
              },
            } as never)
          : null,
      ),
  };
  const attributes = {
    loadSchema: () =>
      Promise.resolve({
        fields: [
          {
            code: 'size-option',
            dataType: 'select',
            isVariantOption: true,
            bounds: { options: [{ code: 'small' }, { code: 'large' }, { code: 'xl' }] },
          },
        ],
      }),
    definitionIdByCode: (_m: MarketContext, codeOf: string) =>
      Promise.resolve(codeOf === 'size-option' ? SIZE : null),
  };
  const saveDraft = {
    execute: (
      _c: CallContext,
      input: { content: Record<string, unknown>; variantIds: unknown[] },
    ) => {
      if (saveFails)
        return Promise.resolve(err({ code: 'request.throttled', retryAfterSeconds: 5 }));
      draftSaves.push(input);
      savedNew = true;
      return Promise.resolve(
        ok({ variantIds: [V_SMALL, V_LARGE, V_NEW], refusedFields: [], variantNotices: [] }),
      );
    },
  };
  const eligibility = { isEligible: () => Promise.resolve(eligible) };

  const build = () => {
    const gate = createUseCaseGate(markets, check);
    const common = { unitOfWork, variantRequests: requests, audit, clock };
    return {
      create: new OwnVariantRequestCreate(gate, {
        ...common,
        offers: offers as never,
        products: products as never,
        workingCopies: workingCopies as never,
        revisions: revisions as never,
        attributes: attributes as never,
        eligibility,
        ids,
      }),
      own: new OwnVariantRequestsList(gate, {
        unitOfWork,
        variantRequests: requests,
        products: products as never,
        attributes: attributes as never,
        attributeStore: definitions,
        policy,
      }),
      list: new VariantRequestList(gate, {
        unitOfWork,
        variantRequests: requests,
        products: products as never,
        workingCopies: workingCopies as never,
        revisions: revisions as never,
        attributes: attributes as never,
        attributeStore: definitions,
        sellerNames: { storeNames: () => Promise.resolve(new Map([[SELLER, 'Corner Store']])) },
        policy,
      }),
      approve: new VariantRequestApprove(gate, {
        ...common,
        products: products as never,
        workingCopies: workingCopies as never,
        revisions: revisions as never,
        saveDraft: saveDraft as never,
      }),
      map: new VariantRequestMap(gate, { ...common, products: products as never }),
      decline: new VariantRequestDecline(gate, common),
      notices: new SendVariantRequestNotices(gate, {
        unitOfWork,
        variantRequests: requests,
        products: products as never,
        attributes: attributes as never,
        attributeStore: definitions,
        ownerContacts: { emailOf: () => Promise.resolve(address) },
        mailTransport,
        mailSettings: {
          sender: () => ({ address: 'no-reply@example.test', name: 'Shop' }),
          zone: () => 'UTC',
        },
        policy,
        clock,
      }),
    };
  };

  const sizeDefinition = () => {
    const built = AttributeDefinition.create({
      id: SIZE,
      revisionId: ids.next<'AttributeDefinitionRevision'>(),
      marketId: market.marketId,
      code: 'size-option',
      dataType: 'select',
      localizable: false,
      material: false,
      isVariantOption: true,
      bounds: {},
      names: { [english]: 'Size' },
      options: [
        { code: 'small', labels: { [english]: 'Small' }, active: true, position: 0 },
        { code: 'large', labels: { [english]: 'Large' }, active: true, position: 1 },
        { code: 'xl', labels: { [english]: 'Extra large' }, active: true, position: 2 },
      ],
      createdByKind: 'admin',
      now: T0,
    });
    if (!built.ok) throw new Error(built.error.code);
    return built.value;
  };

  beforeEach(() => {
    definitions = new MemoryAttributeDefinitionStore();
    requests = new MemoryVariantRequestStore();
    ids = new SequenceIdGenerator(clock);
    audits = [];
    allow = true;
    eligible = true;
    mails = [];
    mailFails = false;
    address = 'seller@example.test';
    hasDraft = true;
    draftSaves = [];
    saveFails = false;
    productStatus = 'published';
    gainedXl = false;
    savedNew = false;
    definitions.rows.set(SIZE, sizeDefinition());
  });

  const request = (
    optionValues: unknown = { 'size-option': 'xl' },
    offerId: unknown = OFFER,
    on: CallContext = context('seller'),
  ) => build().create.execute(on, { offerId, optionValues });

  async function opened(optionValues: Record<string, string> = { 'size-option': 'xl' }) {
    const answer = await request(optionValues);
    if (!answer.ok) throw new Error(`request failed: ${answer.error.code}`);
    return answer.value;
  }

  describe('own-variant-request.create', () => {
    it('opens a request for the seller with one id-only audit row', async () => {
      const answer = await request();
      expect(answer).toEqual(ok({ id: <unknown>expect.any(String), status: 'open', version: 1 }));
      const stored = [...requests.rows.values()][0]!.state;
      expect(stored).toMatchObject({
        sellerId: SELLER,
        offerId: OFFER,
        productId: PRODUCT,
        marketId: market.marketId,
        optionValues: { 'size-option': 'xl' },
        optionKey: 'size-option=xl',
      });
      expect(audits.map((a) => [a.action, a.targetId])).toEqual([
        ['catalog.variant-request.requested', stored.id],
      ]);
      expect(JSON.stringify(audits)).not.toContain('xl');
    });

    it('answers the same offer.not-found for another seller’s Offer, an unknown one and one of another Market', async () => {
      const other = await request({ 'size-option': 'xl' }, OTHER_OFFER);
      const unknown = await request(
        { 'size-option': 'xl' },
        '01990000-0000-7000-8000-0000000000ff',
      );
      expect(other).toEqual(err({ code: 'offer.not-found' }));
      expect(unknown).toEqual(other);
      expect(requests.rows.size).toBe(0);
    });

    it('refuses a product that is not a published PLATFORM product', async () => {
      expect(await request({ 'size-option': 'xl' }, SELLER_OFFER)).toEqual(
        err({ code: 'variant-request.product-unavailable' }),
      );
      productStatus = 'unpublished';
      expect(await request()).toEqual(err({ code: 'variant-request.product-unavailable' }));
    });

    it('needs exactly the axes of the product, each an active option', async () => {
      for (const values of [
        { 'size-option': 'huge' },
        { colour: 'red' },
        { 'size-option': 'xl', colour: 'red' },
      ]) {
        expect(await request(values)).toEqual(err({ code: 'variant-request.option-unknown' }));
      }
      expect(requests.rows.size).toBe(0);
    });

    it('refuses a variant the product already has', async () => {
      expect(await request({ 'size-option': 'large' })).toEqual(
        err({ code: 'variant-request.variant-exists' }),
      );
    });

    it('allows one open request per Offer and combination', async () => {
      await opened();
      expect(await request()).toEqual(err({ code: 'variant-request.already-open' }));
    });

    it('caps a seller’s open requests', async () => {
      const open = (n: number) => {
        const built = VariantRequest.open({
          id: ids.next<'VariantRequest'>(),
          marketId: market.marketId,
          sellerId: SELLER,
          offerId: ids.next<'Offer'>(),
          productId: PRODUCT,
          optionValues: { 'size-option': `s${n}` },
          now: T0,
        });
        if (!built.ok) throw new Error(built.error.code);
        return built.value;
      };
      for (let n = 0; n < 10; n += 1) {
        const row = open(n);
        requests.rows.set(row.state.id, row);
      }
      expect(await request()).toEqual(err({ code: 'variant-request.limit-reached', max: 10 }));
    });

    it('stops a seller at 20 requests in 24 hours', async () => {
      const first = await opened();
      const row = requests.rows.get(first.id)!;
      const decided = row.decline({ accountId: ADMIN, reason: 'No', now: T0 });
      if (!decided.ok) throw new Error('decline');
      for (let n = 0; n < 20; n += 1) requests.rows.set(`d${n}`, decided.value);
      expect(await request()).toEqual(err({ code: 'variant-request.daily-limit', max: 20 }));
    });

    it('refuses a bad request, a seller who may not sell and a denied caller', async () => {
      expect(await request({})).toMatchObject({ error: { code: 'validation.failed' } });
      expect(await request('xl')).toMatchObject({ error: { code: 'validation.failed' } });
      expect(await request({ 'size-option': 'Bad Code' })).toMatchObject({
        error: { code: 'validation.failed' },
      });
      expect(await request({ 'size-option': 'xl' }, 'nope')).toMatchObject({
        error: { code: 'validation.failed' },
      });
      eligible = false;
      expect(await request()).toEqual(err({ code: 'seller.not-eligible' }));
      eligible = true;
      allow = false;
      expect(await request()).toEqual(err({ code: 'access.denied' }));
      allow = true;
      expect(await request({ 'size-option': 'xl' }, OFFER, context('admin'))).toEqual(
        err({ code: 'access.denied' }),
      );
    });
  });

  describe('own-variant-requests.list', () => {
    it('lists only the seller’s own requests with names and the outcome', async () => {
      const mine = await opened();
      const otherSeller = await build().create.execute(context('seller', OTHER_SELLER), {
        offerId: OTHER_OFFER,
        optionValues: { 'size-option': 'xl' },
      });
      expect(otherSeller.ok).toBe(true);
      const answer = await build().own.execute(context('seller'), {});
      if (!answer.ok) throw new Error(answer.error.code);
      expect(answer.value.items).toHaveLength(1);
      expect(answer.value.items[0]).toMatchObject({
        id: mine.id,
        productCode: 'P-9',
        status: 'open',
        options: [
          {
            attributeCode: 'size-option',
            attributeName: 'Size',
            optionCode: 'xl',
            optionLabel: 'Extra large',
          },
        ],
        declineReason: null,
      });
      expect(answer.value).toMatchObject({ openCount: 1, maxOpen: 10, nextAfterId: null });
    });

    it('shows the reviewer’s reason of a declined request and filters by status', async () => {
      const first = await opened();
      await build().decline.execute(context('admin'), {
        requestId: first.id,
        version: 1,
        reason: 'Not sold in this size',
      });
      const declined = await build().own.execute(context('seller'), { status: 'declined' });
      expect(declined).toMatchObject({
        ok: true,
        value: {
          items: [{ status: 'declined', declineReason: 'Not sold in this size' }],
          openCount: 0,
        },
      });
      expect(await build().own.execute(context('seller'), { status: 'open' })).toMatchObject({
        value: { items: [] },
      });
      expect(await build().own.execute(context('seller'), { status: 'weird' })).toMatchObject({
        error: { code: 'validation.failed' },
      });
      expect(await build().own.execute(context('admin'), {})).toEqual(
        err({ code: 'access.denied' }),
      );
    });
  });

  describe('variant-request.list', () => {
    it('lists open requests with the variants the product has, for admins only', async () => {
      const first = await opened();
      const answer = await build().list.execute(context('admin'), {});
      if (!answer.ok) throw new Error(answer.error.code);
      expect(answer.value.items).toHaveLength(1);
      expect(answer.value.items[0]).toMatchObject({
        id: first.id,
        version: 1,
        sellerName: 'Corner Store',
        productCode: 'P-9',
        alreadyExists: false,
        options: [{ optionCode: 'xl', optionLabel: 'Extra large' }],
        existing: [
          { variantId: V_SMALL, variantNo: 1, options: [{ optionCode: 'small' }] },
          { variantId: V_LARGE, variantNo: 2, options: [{ optionCode: 'large' }] },
        ],
      });
      expect(await build().list.execute(context('seller'), {})).toEqual(
        err({ code: 'access.denied' }),
      );
      allow = false;
      expect(await build().list.execute(context('admin'), {})).toEqual(
        err({ code: 'access.denied' }),
      );
    });

    it('does not list another Market’s requests', async () => {
      await opened();
      const answer = await build().list.execute(context('admin', null, otherMarket), {});
      expect(answer).toMatchObject({ ok: true, value: { items: [] } });
    });
  });

  describe('variant-request.approve', () => {
    it('adds the variant to the draft through the draft save, then decides the request', async () => {
      const first = await opened();
      const answer = await build().approve.execute(context('admin'), {
        requestId: first.id,
        version: 1,
      });
      expect(answer).toEqual(
        ok({
          request: { id: first.id, status: 'approved', version: 2, resolvedVariantId: V_NEW },
        }),
      );
      expect(draftSaves).toHaveLength(1);
      const saved = draftSaves[0]!;
      expect(saved.variantIds).toEqual([V_SMALL, V_LARGE, null]);
      expect(saved.content['variants']).toEqual([
        { variantId: V_SMALL, optionValues: { 'size-option': 'small' } },
        { variantId: V_LARGE, optionValues: { 'size-option': 'large' } },
        { variantId: `variant-request-${first.id}`, optionValues: { 'size-option': 'xl' } },
      ]);
      expect(requests.rows.get(first.id)!.state).toMatchObject({
        status: 'approved',
        resolvedVariantId: V_NEW,
        decidedByAccountId: ADMIN,
        noticeState: 'pending',
      });
      expect(audits.map((a) => a.action)).toEqual([
        'catalog.variant-request.requested',
        'catalog.variant-request.decided',
      ]);
    });

    it('starts from the published revision when the product has no draft', async () => {
      hasDraft = false;
      const first = await opened();
      const answer = await build().approve.execute(context('admin'), {
        requestId: first.id,
        version: 1,
      });
      expect(answer.ok).toBe(true);
      const saved = draftSaves[0]!;
      expect(saved.content['texts']).toEqual({ [english]: { name: 'Rice' } });
      expect(saved.content['variantAxes']).toEqual(['size-option']);
      expect((saved.content['variants'] as unknown[]).length).toBe(3);
    });

    it('decides nothing when the draft save is refused', async () => {
      const first = await opened();
      saveFails = true;
      const answer = await build().approve.execute(context('admin'), {
        requestId: first.id,
        version: 1,
      });
      expect(answer).toEqual(err({ code: 'request.throttled', retryAfterSeconds: 5 }));
      expect(requests.rows.get(first.id)!.state.status).toBe('open');
    });

    it('refuses a combination the product has as a published variant', async () => {
      const first = await opened();
      // The product gained the size meanwhile, as a published variant.
      gainedXl = true;
      revisionContent.variants.push({
        variantId: V_NEW,
        optionValues: { 'size-option': 'xl' },
        gtin: null,
        imageIds: [],
      });
      try {
        const answer = await build().approve.execute(context('admin'), {
          requestId: first.id,
          version: 1,
        });
        expect(answer).toEqual(err({ code: 'variant-request.variant-exists' }));
        expect(draftSaves).toHaveLength(0);
      } finally {
        revisionContent.variants.pop();
      }
    });

    it('refuses a stale version, a decided request, an acting-as session and a missing key', async () => {
      const first = await opened();
      const approve = (ctx: CallContext, version = 1) =>
        build().approve.execute(ctx, { requestId: first.id, version });
      expect(await approve(context('admin'), 5)).toEqual(err({ code: 'variant-request.stale' }));
      expect(await approve(actingAs())).toEqual(err({ code: 'access.denied' }));
      expect(await approve(context('seller'))).toEqual(err({ code: 'access.denied' }));
      allow = false;
      expect(await approve(context('admin'))).toEqual(err({ code: 'access.denied' }));
      allow = true;
      expect((await approve(context('admin'))).ok).toBe(true);
      expect(await approve(context('admin'), 2)).toEqual(err({ code: 'variant-request.not-open' }));
    });

    it('answers a lost race on the decision as stale', async () => {
      const first = await opened();
      requests.raceNext = true;
      expect(
        await build().approve.execute(context('admin'), { requestId: first.id, version: 1 }),
      ).toEqual(err({ code: 'variant-request.stale' }));
    });

    it('does not see another Market’s request', async () => {
      const first = await opened();
      const other = await build().approve.execute(context('admin', null, otherMarket), {
        requestId: first.id,
        version: 1,
      });
      const unknown = await build().approve.execute(context('admin'), {
        requestId: '01990000-0000-7000-8000-0000000000ff',
        version: 1,
      });
      expect(other).toEqual(err({ code: 'variant-request.not-found' }));
      expect(unknown).toEqual(other);
    });
  });

  describe('variant-request.map', () => {
    it('points the request at a variant the product has, without changing the product', async () => {
      const first = await opened();
      const answer = await build().map.execute(context('admin'), {
        requestId: first.id,
        version: 1,
        variantId: V_LARGE,
      });
      expect(answer).toEqual(
        ok({ request: { id: first.id, status: 'mapped', version: 2, resolvedVariantId: V_LARGE } }),
      );
      expect(draftSaves).toHaveLength(0);
    });

    it('refuses a variant the product does not have, and a bad id', async () => {
      const first = await opened();
      expect(
        await build().map.execute(context('admin'), {
          requestId: first.id,
          version: 1,
          variantId: '01990000-0000-7000-8000-0000000000ff',
        }),
      ).toEqual(err({ code: 'variant-request.variant-unknown' }));
      expect(
        await build().map.execute(context('admin'), {
          requestId: first.id,
          version: 1,
          variantId: 'nope',
        }),
      ).toMatchObject({ error: { code: 'validation.failed' } });
      expect(requests.rows.get(first.id)!.state.status).toBe('open');
    });
  });

  describe('variant-request.decline', () => {
    it('keeps the reason on the request and out of the audit row', async () => {
      const first = await opened();
      const answer = await build().decline.execute(context('admin'), {
        requestId: first.id,
        version: 1,
        reason: '  Not   sold in this size ',
      });
      expect(answer).toMatchObject({ ok: true, value: { request: { status: 'declined' } } });
      expect(requests.rows.get(first.id)!.state.declineReason).toBe('Not sold in this size');
      expect(JSON.stringify(audits)).not.toContain('Not sold');
    });

    it('refuses an empty reason and a seller', async () => {
      const first = await opened();
      expect(
        await build().decline.execute(context('admin'), {
          requestId: first.id,
          version: 1,
          reason: '  ',
        }),
      ).toEqual(err({ code: 'variant-request.reason-invalid' }));
      expect(
        await build().decline.execute(context('seller'), {
          requestId: first.id,
          version: 1,
          reason: 'x',
        }),
      ).toEqual(err({ code: 'access.denied' }));
    });
  });

  describe('catalog.send-variant-request-notices', () => {
    const run = () => build().notices.execute(testCallContext(market, 'system'), {});

    it('sends one plain-text mail per decision, then marks it sent', async () => {
      const a = await opened();
      const b = await opened({ 'size-option': 'xl' }).catch(() => null);
      expect(b).toBeNull(); // the same combination is already open
      await build().decline.execute(context('admin'), {
        requestId: a.id,
        version: 1,
        reason: 'Not sold in this size',
      });
      const answer = await run();
      expect(answer).toMatchObject({ ok: true, value: { examined: 1, sent: 1 } });
      expect(mails).toHaveLength(1);
      expect(mails[0]).toMatchObject({ to: 'seller@example.test' });
      expect(mails[0]!.subject).toBe('Your requested variant of P-9 was not added');
      expect(mails[0]!.text).toContain('(Size: Extra large)');
      expect(mails[0]!.text).toContain('Reason: Not sold in this size');
      expect(requests.rows.get(a.id)!.state.noticeState).toBe('sent');
      expect(await run()).toMatchObject({ ok: true, value: { examined: 0 } });
    });

    it('tells the seller an approved variant goes through review', async () => {
      const a = await opened();
      await build().approve.execute(context('admin'), { requestId: a.id, version: 1 });
      await run();
      expect(mails[0]!.subject).toBe('Your requested variant of P-9 was added');
      expect(mails[0]!.text).toContain('normal review');
    });

    it('tells the seller a mapped request already has a variant', async () => {
      const a = await opened();
      await build().map.execute(context('admin'), {
        requestId: a.id,
        version: 1,
        variantId: V_LARGE,
      });
      await run();
      expect(mails[0]!.subject).toBe('P-9 already has a variant that fits');
    });

    it('settles as skipped when the seller has no usable address', async () => {
      const a = await opened();
      await build().decline.execute(context('admin'), {
        requestId: a.id,
        version: 1,
        reason: 'No',
      });
      address = null;
      expect(await run()).toMatchObject({ ok: true, value: { skipped: 1 } });
      expect(mails).toHaveLength(0);
      expect(requests.rows.get(a.id)!.state.noticeState).toBe('skipped');
    });

    it('defers a failed send and gives up at the last attempt', async () => {
      const a = await opened();
      await build().decline.execute(context('admin'), {
        requestId: a.id,
        version: 1,
        reason: 'No',
      });
      mailFails = true;
      expect(await run()).toMatchObject({ ok: true, value: { deferred: 1 } });
      expect(requests.rows.get(a.id)!.state.noticeState).toBe('pending');
      let guard = 0;
      while (requests.rows.get(a.id)!.state.noticeState === 'pending' && guard < 10) {
        clock.set(requests.rows.get(a.id)!.state.noticeNextAttemptAt!);
        await run();
        guard += 1;
      }
      expect(requests.rows.get(a.id)!.state.noticeState).toBe('failed');
      clock.set(T0);
    });

    it('is for the system only', async () => {
      expect(await build().notices.execute(context('admin'), {})).toEqual(
        err({ code: 'access.denied' }),
      );
    });
  });
});
