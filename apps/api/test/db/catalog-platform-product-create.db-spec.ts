import { randomUUID } from 'node:crypto';
import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import type { AuthorisationCheck } from '../../src/platform/authz';
import type { AttributeRepository } from '../../src/modules/catalog/application/ports/attribute.repository';
import type { ProductRepository } from '../../src/modules/catalog/application/ports/product.repository';
import { PlatformProductCreate } from '../../src/modules/catalog/application/use-cases/platform-product-create.use-case';
import { configurableProductType } from '../../src/modules/catalog/domain/product-types/configurable';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { ConfigCatalogMarketPolicy } from '../../src/modules/catalog/infrastructure/config-catalog-market-policy';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Catalog slice 6 (platform-product.create) on PostgreSQL, for both Market fixtures: the product,
// its one variant and its events are written in one unit under the Market's own configuration.

const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const clock = new FixedClock(T0);
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)(
  'catalog platform product create in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    let persistence: Persistence;
    let app: Client;
    let useCase: PlatformProductCreate;
    let appended: string[];
    let failOutbox = false;
    const adminContext = () =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: uuid7() as Id<'Account'>,
          sessionId: uuid7() as Id<'Session'>,
          sellerId: null,
        }),
      );

    beforeAll(async () => {
      persistence = createPersistence();
      app = new Client({ connectionString: testDatabaseUrl() });
      await app.connect();
      const markets = new MarketRegistry(
        loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS),
      );
      const real = new PrismaProductRepository(persistence.service);
      // Not the shared counter: a parallel spec asserts consecutive codes from it.
      const products: ProductRepository = {
        nextProductCode: () =>
          Promise.resolve(`Q${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`),
        add: (m, product) => real.add(m, product),
        findById: (m, id) => real.findById(m, id),
        save: (m, product) => real.save(m, product),
      };
      const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
      const handlers = { simple: simpleProductType, configurable: configurableProductType };
      useCase = new PlatformProductCreate(createUseCaseGate(markets, admitAll), {
        unitOfWork: persistence.unitOfWork,
        products,
        attributes: {
          loadSchema: () => Promise.resolve({ fields: [] }),
        } as unknown as AttributeRepository,
        policy: new ConfigCatalogMarketPolicy(markets),
        productTypes: (typeCode) => handlers[typeCode as keyof typeof handlers],
        outbox: {
          append: (_context, events) => {
            if (failOutbox) return Promise.reject(new Error('outbox down'));
            appended.push(...events.map((event) => event.type));
            return Promise.resolve();
          },
        },
        clock,
        ids: { next: <K extends string>() => uuid7() as Id<K> },
      });
    });
    beforeEach(() => {
      appended = [];
    });
    afterAll(async () => {
      await app.end();
      await persistence.close();
    });

    it('stores a PLATFORM Simple draft with its one proposed variant and appends the events', async () => {
      const result = await useCase.execute(
        testCallContext(
          market,
          testAuthenticatedActor(market, {
            population: 'admin',
            accountId: uuid7() as Id<'Account'>,
            sessionId: uuid7() as Id<'Session'>,
            sellerId: null,
          }),
        ),
        { typeCode: 'simple' },
      );
      if (!result.ok) throw new Error(result.error.code);
      const { rows } = await app.query(
        `SELECT scope, status, type_code, family_code, owner_seller_id FROM catalog.products WHERE id = $1`,
        [result.value.productId],
      );
      expect(rows[0]).toMatchObject({
        scope: 'PLATFORM',
        status: 'draft',
        type_code: 'simple',
        family_code: 'default',
        owner_seller_id: null,
      });
      const variants = await app.query(
        `SELECT state FROM catalog.product_variants WHERE product_id = $1`,
        [result.value.productId],
      );
      expect(variants.rows).toEqual([{ state: 'proposed' }]);
      expect(appended).toContain('catalog.variant-added.v1');
    });

    it('keeps the version, Market and tenant, and gives a second create another code', async () => {
      const first = await useCase.execute(adminContext(), { typeCode: 'simple' });
      const second = await useCase.execute(adminContext(), { typeCode: 'simple' });
      if (!first.ok || !second.ok) throw new Error('create failed');
      expect(second.value.productCode).not.toBe(first.value.productCode);
      const { rows } = await app.query(
        `SELECT version, market_id, tenant_id FROM catalog.products WHERE id = $1`,
        [first.value.productId],
      );
      expect(rows[0]).toMatchObject({ market_id: code, tenant_id: market.tenantId });
      expect(Number((rows[0] as { version: unknown }).version)).toBeGreaterThanOrEqual(1);
    });

    it('creates a Configurable product without variants where the Market lists it, else refuses', async () => {
      const result = await useCase.execute(adminContext(), { typeCode: 'configurable' });
      if (code === 'ZZ') {
        expect(result).toEqual({ ok: false, error: { code: 'product.type-not-offered' } });
        return;
      }
      if (!result.ok) throw new Error(result.error.code);
      const variants = await app.query(
        `SELECT 1 FROM catalog.product_variants WHERE product_id = $1`,
        [result.value.productId],
      );
      expect(variants.rows).toHaveLength(0);
    });

    it('stores nothing when the events cannot be written', async () => {
      failOutbox = true;
      try {
        const before = await app.query(
          `SELECT count(*)::int AS n FROM catalog.products WHERE market_id = $1 AND product_code LIKE 'Q%'`,
          [code],
        );
        await expect(useCase.execute(adminContext(), { typeCode: 'simple' })).rejects.toThrow();
        const after = await app.query(
          `SELECT count(*)::int AS n FROM catalog.products WHERE market_id = $1 AND product_code LIKE 'Q%'`,
          [code],
        );
        expect((after.rows[0] as { n: number }).n).toBe((before.rows[0] as { n: number }).n);
      } finally {
        failOutbox = false;
      }
    });
  },
);
