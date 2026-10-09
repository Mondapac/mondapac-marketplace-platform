import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import type { CheckClaimText } from '../../src/modules/catalog/application/claim-text/check-claim-text.service';
import { OwnOfferCreateOnPlatformProduct } from '../../src/modules/catalog/application/use-cases/own-offer-create-on-platform-product.use-case';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { ConfigCatalogMarketPolicy } from '../../src/modules/catalog/infrastructure/config-catalog-market-policy';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// Catalog slice 7a-2 (own-offer.create-on-platform-product) on PostgreSQL, for both Market
// fixtures: the Offer, its first history row and its event are written in one unit, and a refused
// creation leaves no Offer, no history row and no event behind (Hassan L-1, Mojtaba 2).

const T0 = Temporal.Instant.from('2026-10-09T00:00:00Z');
const clock = new FixedClock(T0);
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ids = { next: <K extends string>() => uuid7() as Id<K> };

describe.each(TEST_MARKETS)(
  'catalog own-offer create on a platform product in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    let persistence: Persistence;
    let owner: Client;
    let useCase: OwnOfferCreateOnPlatformProduct;
    let products: PrismaProductRepository;
    let appended: string[];
    let failOutbox = false;
    const policy = new ConfigCatalogMarketPolicy(
      new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS)),
    );
    const locale = policy.locales(market).default;
    const condition = policy.conditions(market)[0]!;
    const sellerId = uuid7() as Id<'Seller'>;
    const sellerContext = () =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: uuid7() as Id<'Account'>,
          sessionId: uuid7() as Id<'Session'>,
          sellerId,
        }),
      );

    beforeAll(async () => {
      persistence = createPersistence();
      owner = new Client({ connectionString: ownerTestDatabaseUrl() });
      await owner.connect();
      products = new PrismaProductRepository(persistence.service);
      const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
      const markets = new MarketRegistry(
        loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS),
      );
      useCase = new OwnOfferCreateOnPlatformProduct(createUseCaseGate(markets, admitAll), {
        unitOfWork: persistence.unitOfWork,
        products,
        offers: new PrismaOfferRepository(persistence.service, ids),
        eligibility: { isEligible: () => Promise.resolve(true) },
        allowedTypes: { allowedFor: () => Promise.resolve('all' as const) },
        check: {
          execute: (_c: unknown, texts: readonly { locale: string }[]) =>
            Promise.resolve({
              ok: true as const,
              value: texts.map((item) => ({
                code: 'clean' as const,
                field: 'offer.description' as const,
                ref: null,
                locale: item.locale,
              })),
            }),
        } as unknown as CheckClaimText,
        policy,
        outbox: {
          append: (_context, events) => {
            if (failOutbox) return Promise.reject(new Error('outbox down'));
            appended.push(...events.map((event) => event.type));
            return Promise.resolve();
          },
        },
        clock,
        ids,
      });
    });
    beforeEach(() => {
      appended = [];
      failOutbox = false;
    });
    afterAll(async () => {
      await owner.end();
      await persistence.close();
    });

    /** A PLATFORM Simple product stored as `published` (the use case reads only its status). */
    async function platformProduct(status: 'published' | 'draft' = 'published') {
      const created = Product.create({
        id: uuid7() as Id<'Product'>,
        marketId: market.marketId,
        scope: 'PLATFORM',
        sellerId: null,
        handler: simpleProductType,
        familyCode: 'default',
        productCode: `Q${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
        variantId: uuid7() as Id<'Variant'>,
        now: T0,
      });
      if (!created.ok) throw new Error(created.error.code);
      const res = await persistence.unitOfWork.run(market, async () => ({
        ok: true as const,
        value: await products.add(market, created.value),
      }));
      if (!res.ok) throw new Error('add failed');
      if (status === 'published') {
        const base = { market_id: market.marketId, tenant_id: market.tenantId };
        const insertRow = async (table: string, row: Record<string, unknown>) => {
          const columns = Object.keys(row);
          await owner.query(
            `INSERT INTO catalog.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
            Object.values(row),
          );
        };
        const familyId = uuid7();
        const familyRevisionId = uuid7();
        const revisionId = uuid7();
        await insertRow('attribute_families', {
          id: familyId,
          ...base,
          code: `f-${uuid7().slice(-10)}`,
          status: 'active',
          created_by_kind: 'seed',
          version: 1,
          created_at: T0.toString(),
        });
        await insertRow('attribute_family_revisions', {
          id: familyRevisionId,
          ...base,
          family_id: familyId,
          revision_no: 1,
          groups: '[]',
          author_kind: 'seed',
          created_at: T0.toString(),
        });
        await insertRow('product_revisions', {
          id: revisionId,
          ...base,
          product_id: created.value.state.id,
          revision_no: 1,
          revision_kind: 'submission',
          base_revision_id: null,
          reverted_from_revision_id: null,
          family_revision_id: familyRevisionId,
          definition_revision_ids: [],
          tax_category_code: 'standard',
          attribute_values: '{}',
          field_provenance: null,
          sensitive: false,
          sensitive_reasons: [],
          content_schema_version: 1,
          content_hash: `sha256:${'a'.repeat(64)}`,
          author_kind: 'admin',
          author_account_id: uuid7(),
          acting_admin_account_id: null,
          submitted_at: T0.toString(),
        });
        await owner.query(
          `UPDATE catalog.products SET status = 'published', published_revision_id = $3
             WHERE market_id = $1 AND id = $2`,
          [market.marketId, created.value.state.id, revisionId],
        );
      }
      return created.value.state.id;
    }

    const request = (productId: Id<'Product'>, sellerSku = `SKU-${uuid7().slice(-12)}`) => ({
      productId,
      sellerSku,
      conditionCode: condition,
      description: { [locale]: 'A tidy listing' },
    });
    const counts = async () =>
      (
        await owner.query(
          `SELECT (SELECT count(*) FROM catalog.offers WHERE seller_id = $1)::int AS offers,
                  (SELECT count(*) FROM catalog.offer_history h JOIN catalog.offers o
                     ON o.market_id = h.market_id AND o.id = h.offer_id
                    WHERE o.seller_id = $1)::int AS history`,
          [sellerId],
        )
      ).rows[0] as { offers: number; history: number };

    it('stores the draft Offer for the actor’s seller with its history row and event', async () => {
      const productId = await platformProduct();
      const before = await counts();
      const result = await useCase.execute(sellerContext(), request(productId));
      if (!result.ok) throw new Error(result.error.code);
      const { rows } = await owner.query(
        `SELECT status, seller_id, handling, listed, version, market_id FROM catalog.offers WHERE id = $1`,
        [result.value.offerId],
      );
      expect(rows[0]).toEqual({
        status: 'draft',
        seller_id: sellerId,
        handling: null,
        listed: false,
        version: 1,
        market_id: code,
      });
      const after = await counts();
      expect(after.offers).toBe(before.offers + 1);
      expect(after.history).toBe(before.history + 1);
      expect(appended).toEqual(['catalog.offer-created.v1']);
    });

    it('refuses a product that is not published, as product.not-found', async () => {
      const productId = await platformProduct('draft');
      const before = await counts();
      const result = await useCase.execute(sellerContext(), request(productId));
      expect(result).toEqual({ ok: false, error: { code: 'product.not-found' } });
      expect(await counts()).toEqual({ ...before });
    });

    it('answers the second Offer of the seller on a product and leaves nothing behind', async () => {
      const productId = await platformProduct();
      const first = await useCase.execute(sellerContext(), request(productId));
      expect(first.ok).toBe(true);
      const before = await counts();
      appended = [];
      const second = await useCase.execute(sellerContext(), request(productId));
      expect(second).toEqual({ ok: false, error: { code: 'offer.exists-for-product' } });
      expect(await counts()).toEqual({ ...before });
      expect(appended).toEqual([]);
    });

    it('answers a taken SKU of the same seller and leaves nothing behind', async () => {
      const first = await useCase.execute(
        sellerContext(),
        request(await platformProduct(), 'SKU-DUP'),
      );
      expect(first.ok).toBe(true);
      const before = await counts();
      appended = [];
      const clash = await useCase.execute(
        sellerContext(),
        request(await platformProduct(), 'SKU-DUP'),
      );
      expect(clash).toEqual({ ok: false, error: { code: 'offer.sku-taken' } });
      expect(await counts()).toEqual({ ...before });
      expect(appended).toEqual([]);
    });

    it('lets another seller offer the same product and reuse a SKU', async () => {
      const productId = await platformProduct();
      const otherContext = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: uuid7() as Id<'Account'>,
          sessionId: uuid7() as Id<'Session'>,
          sellerId: uuid7() as Id<'Seller'>,
        }),
      );
      expect((await useCase.execute(sellerContext(), request(productId, 'SKU-SHARED'))).ok).toBe(
        true,
      );
      expect((await useCase.execute(otherContext, request(productId, 'SKU-SHARED'))).ok).toBe(true);
    });

    it('answers an unknown product id as product.not-found', async () => {
      const result = await useCase.execute(sellerContext(), request(uuid7() as Id<'Product'>));
      expect(result).toEqual({ ok: false, error: { code: 'product.not-found' } });
    });

    it('lets the seller create again after the earlier Offer is deleted', async () => {
      const productId = await platformProduct();
      const first = await useCase.execute(sellerContext(), request(productId, 'SKU-GONE'));
      if (!first.ok) throw new Error(first.error.code);
      await owner.query(
        `UPDATE catalog.offers SET status = 'deleted', deleted_at = now() WHERE id = $1`,
        [first.value.offerId],
      );
      const again = await useCase.execute(sellerContext(), request(productId, 'SKU-GONE'));
      expect(again.ok).toBe(true);
    });

    it('rolls back the Offer and its history when the outbox write fails', async () => {
      const productId = await platformProduct();
      const before = await counts();
      failOutbox = true;
      await expect(useCase.execute(sellerContext(), request(productId))).rejects.toThrow();
      expect(await counts()).toEqual({ ...before });
    });

    it('does not see a product of another Market', async () => {
      const productId = await platformProduct();
      const otherCode = TEST_MARKETS.find((candidate) => candidate !== code)!;
      const otherMarket = marketOf(otherCode);
      const result = await useCase.execute(
        testCallContext(
          otherMarket,
          testAuthenticatedActor(otherMarket, {
            population: 'seller',
            accountId: uuid7() as Id<'Account'>,
            sessionId: uuid7() as Id<'Session'>,
            sellerId,
          }),
        ),
        {
          ...request(productId),
          conditionCode: policy.conditions(otherMarket)[0]!,
          description: { [policy.locales(otherMarket).default]: 'A tidy listing' },
        },
      );
      expect(result).toEqual({ ok: false, error: { code: 'product.not-found' } });
    });
  },
);
