import { randomUUID } from 'node:crypto';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { uuidV7 } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { Product } from '../../src/modules/catalog/domain/product';
import { configurableProductType } from '../../src/modules/catalog/domain/product-types/configurable';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Catalog slice 1 on PostgreSQL (catalog data design 3.1 to 3.3, 5.1, 7), for both Market
// fixtures: the repository round trip, the product-code counter, optimistic saving, the
// variant registry and its guard trigger, and the constraints and grants of the migration.

const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const T1 = Temporal.Instant.from('2026-10-08T01:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

function newProduct(
  marketId: string,
  overrides: { configurable?: boolean; scope?: 'SELLER' | 'PLATFORM'; code: string },
): Product {
  const scope = overrides.scope ?? 'SELLER';
  const created = Product.create({
    id: uuid7() as Id<'Product'>,
    marketId: marketId as MarketId,
    scope,
    sellerId: scope === 'SELLER' ? (uuid7() as Id<'Seller'>) : null,
    handler: overrides.configurable ? configurableProductType : simpleProductType,
    familyCode: 'default',
    productCode: overrides.code,
    variantId: overrides.configurable ? null : (uuid7() as Id<'Variant'>),
    now: T0,
  });
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

describe.each(TEST_MARKETS)('catalog products in market %s (database integration)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let persistence: Persistence;
  let repository: PrismaProductRepository;
  let app: Client;
  let owner: Client;

  beforeAll(async () => {
    persistence = createPersistence();
    repository = new PrismaProductRepository(persistence.service);
    app = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await app.connect();
    await owner.connect();
  });
  afterAll(async () => {
    await app.end();
    await owner.end();
    await persistence.close();
  });

  const inUnit = <T>(work: () => Promise<T>): Promise<T> =>
    persistence.unitOfWork
      .run(market, async () => ({ ok: true as const, value: await work() }))
      .then((result) => {
        if (!result.ok) throw new Error('unit failed');
        return result.value;
      });

  const inUnitOf =
    (target: typeof market) =>
    <T>(work: () => Promise<T>): Promise<T> =>
      persistence.unitOfWork
        .run(target, async () => ({ ok: true as const, value: await work() }))
        .then((result) => {
          if (!result.ok) throw new Error('unit failed');
          return result.value;
        });

  /** The SQLSTATE of a statement that must fail, or null when it succeeded. */
  async function sqlState(
    client: Client,
    text: string,
    values: unknown[] = [],
  ): Promise<string | null> {
    try {
      await client.query(text, values);
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    }
  }

  async function insertProduct(overrides: Record<string, unknown> = {}): Promise<string> {
    const id = uuid7();
    const row = {
      id,
      market_id: market.marketId,
      tenant_id: market.tenantId,
      scope: 'PLATFORM',
      owner_seller_id: null,
      created_by_seller_id: null,
      type_code: 'configurable',
      variant_model: 'options',
      family_code: 'default',
      product_code: `X${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
      status: 'draft',
      own_brand: false,
      last_changed_at: T0.toString(),
      version: 1,
      created_at: T0.toString(),
      ...overrides,
    };
    const columns = Object.keys(row);
    await app.query(
      `INSERT INTO catalog.products (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
    return id;
  }

  async function insertVariant(productId: string, overrides: Record<string, unknown> = {}) {
    const row = {
      id: uuid7(),
      market_id: market.marketId,
      tenant_id: market.tenantId,
      product_id: productId,
      variant_model: 'options',
      state: 'proposed',
      created_at: T0.toString(),
      ...overrides,
    };
    const columns = Object.keys(row);
    await app.query(
      `INSERT INTO catalog.product_variants (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
    return row.id;
  }

  it('hands out product codes one after another, per Market', async () => {
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push(await inUnit(() => repository.nextProductCode(market)));
    const first = Number(codes[0]!.slice(1));
    expect(codes).toEqual(
      [first, first + 1, first + 2].map((n) => `P${String(n).padStart(8, '0')}`),
    );
    const [otherCode] = [await inUnitOf(other)(() => repository.nextProductCode(other))];
    expect(otherCode).toMatch(/^P\d{8}$/);
  });

  it('gives two concurrent units different codes', async () => {
    const taken = await Promise.all(
      Array.from({ length: 5 }, () => inUnit(() => repository.nextProductCode(market))),
    );
    expect(new Set(taken).size).toBe(5);
  });

  it('stores a Simple product with its variant and reads it back', async () => {
    const product = newProduct(market.marketId, {
      code: await inUnit(() => repository.nextProductCode(market)),
    });
    await inUnit(() => repository.add(market, product));

    const found = await inUnit(() => repository.findById(market, product.state.id));
    expect(found?.state).toEqual(product.state);
    expect(found?.persistedVersion).toBe(1);
    expect(found?.state.variants).toHaveLength(1);
  });

  it('does not find a product of another Market, nor an unknown id', async () => {
    const product = newProduct(market.marketId, {
      code: await inUnit(() => repository.nextProductCode(market)),
    });
    await inUnit(() => repository.add(market, product));

    expect(await inUnitOf(other)(() => repository.findById(other, product.state.id))).toBeNull();
    expect(await inUnit(() => repository.findById(market, uuid7() as Id<'Product'>))).toBeNull();
  });

  it('saves a discard of a stored Configurable draft whose several events take consecutive versions', async () => {
    const created = newProduct(market.marketId, {
      configurable: true,
      code: await inUnit(() => repository.nextProductCode(market)),
    });
    await inUnit(() => repository.add(market, created));
    const first = (await inUnit(() => repository.findById(market, created.state.id)))!;
    for (let n = 0; n < 3; n++) first.addVariant(uuid7() as Id<'Variant'>, 5, T1);
    await inUnit(() => repository.save(market, first));

    const stored = (await inUnit(() => repository.findById(market, created.state.id)))!;
    const base = stored.state.version;
    stored.discard(T1);
    expect(stored.pendingEvents.map((event) => event.aggregateVersion)).toEqual([
      base + 1,
      base + 2,
      base + 3,
    ]);
    await inUnit(() => repository.save(market, stored));

    const again = (await inUnit(() => repository.findById(market, created.state.id)))!;
    expect(again.state.version).toBe(base + 3);
    expect(again.state.status).toBe('discarded');
    expect(again.state.variants.every((variant) => variant.state === 'retired')).toBe(true);
  });

  it('saves a Configurable product with added and removed variants', async () => {
    const created = newProduct(market.marketId, {
      configurable: true,
      code: await inUnit(() => repository.nextProductCode(market)),
    });
    await inUnit(() => repository.add(market, created));

    const loaded = (await inUnit(() => repository.findById(market, created.state.id)))!;
    const [a, b] = [uuid7() as Id<'Variant'>, uuid7() as Id<'Variant'>];
    loaded.addVariant(a, 5, T1);
    loaded.addVariant(b, 5, T1);
    loaded.removeProposedVariant(a, T1);
    await inUnit(() => repository.save(market, loaded));

    const again = (await inUnit(() => repository.findById(market, created.state.id)))!;
    expect(again.state.version).toBe(loaded.state.version);
    expect(again.state.variants.map((v) => [v.id, v.state])).toEqual([
      [a, 'retired'],
      [b, 'proposed'],
    ]);
    expect(again.state.variants[0]?.retiredAt?.toString()).toBe(T1.toString());
  });

  it('discards a Simple product: product first, then its single variant', async () => {
    const created = newProduct(market.marketId, {
      code: await inUnit(() => repository.nextProductCode(market)),
    });
    await inUnit(() => repository.add(market, created));

    const loaded = (await inUnit(() => repository.findById(market, created.state.id)))!;
    loaded.discard(T1);
    await inUnit(() => repository.save(market, loaded));

    const again = (await inUnit(() => repository.findById(market, created.state.id)))!;
    expect(again.state.status).toBe('discarded');
    expect(again.state.discardedAt?.toString()).toBe(T1.toString());
    expect(again.state.variants[0]?.state).toBe('retired');
  });

  it('refuses a save of a product that changed since it was read', async () => {
    const created = newProduct(market.marketId, {
      configurable: true,
      code: await inUnit(() => repository.nextProductCode(market)),
    });
    await inUnit(() => repository.add(market, created));
    const first = (await inUnit(() => repository.findById(market, created.state.id)))!;
    const second = (await inUnit(() => repository.findById(market, created.state.id)))!;
    first.discard(T1);
    second.discard(T1);

    await inUnit(() => repository.save(market, first));
    await expect(inUnit(() => repository.save(market, second))).rejects.toBeInstanceOf(
      StaleAggregateError,
    );
  });

  it('refuses to save a product that was never stored', async () => {
    const fresh = newProduct(market.marketId, { code: 'P99999990' });
    await expect(inUnit(() => repository.save(market, fresh))).rejects.toThrow('use add');
  });

  describe('the constraints and grants of the migration', () => {
    it('refuses a scope and an owner that disagree, an unknown scope and status', async () => {
      expect(await sqlState(app, `INSERT INTO catalog.products (id) VALUES ($1)`, [uuid7()])).toBe(
        '23502',
      );
      await expect(insertProduct({ scope: 'SELLER', owner_seller_id: null })).rejects.toMatchObject(
        { code: '23514' },
      );
      await expect(
        insertProduct({ scope: 'PLATFORM', owner_seller_id: uuid7() }),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(insertProduct({ scope: 'OTHER' })).rejects.toMatchObject({ code: '23514' });
      await expect(insertProduct({ status: 'live' })).rejects.toMatchObject({ code: '23514' });
    });

    it('refuses a discarded status without its instant and the reverse', async () => {
      await expect(insertProduct({ status: 'discarded' })).rejects.toMatchObject({ code: '23514' });
      await expect(insertProduct({ discarded_at: T1.toString() })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(
        insertProduct({ status: 'discarded', discarded_at: T1.toString() }),
      ).resolves.toBeDefined();
    });

    it('refuses a malformed product code and a repeated one, case-sensitively', async () => {
      await expect(insertProduct({ product_code: 'p0000001' })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(insertProduct({ product_code: 'AB' })).rejects.toMatchObject({ code: '23514' });
      const code = `Q${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
      await insertProduct({ product_code: code });
      await expect(insertProduct({ product_code: code })).rejects.toMatchObject({ code: '23505' });
    });

    it('refuses a product that matches itself', async () => {
      const id = await insertProduct();
      expect(
        await sqlState(
          app,
          `UPDATE catalog.products SET status = 'matched', matched_into_product_id = $1 WHERE id = $1`,
          [id],
        ),
      ).toBe('23514');
    });

    it('lets the application change status columns but not type, family, code or creator', async () => {
      const id = await insertProduct();
      expect(
        await sqlState(
          app,
          `UPDATE catalog.products SET version = 2, last_changed_at = $2 WHERE id = $1`,
          [id, T1.toString()],
        ),
      ).toBeNull();
      for (const column of [
        'type_code',
        'family_code',
        'product_code',
        'created_by_seller_id',
        'variant_model',
        'market_id',
        'created_at',
      ]) {
        const value =
          column === 'created_by_seller_id'
            ? uuid7()
            : column === 'created_at'
              ? T1.toString()
              : column === 'market_id'
                ? 'AU'
                : 'zzz';
        expect(
          await sqlState(app, `UPDATE catalog.products SET ${column} = $2 WHERE id = $1`, [
            id,
            value,
          ]),
        ).toBe('42501');
      }
    });

    it('lets nobody delete a product, and the application not even try', async () => {
      const id = await insertProduct();
      expect(await sqlState(app, `DELETE FROM catalog.products WHERE id = $1`, [id])).toBe('42501');
    });

    it('accepts only server-minted version 7 variant ids', async () => {
      const product = await insertProduct();
      await expect(insertVariant(product, { id: randomUUID() })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(insertVariant(product)).resolves.toBeDefined();
    });

    it('allows exactly one variant row for a Simple product', async () => {
      const product = await insertProduct({ type_code: 'simple', variant_model: 'single' });
      await insertVariant(product, { variant_model: 'single' });
      await expect(insertVariant(product, { variant_model: 'single' })).rejects.toMatchObject({
        code: '23505',
      });
    });

    it('binds a variant to its product, its Market and its variant model', async () => {
      const product = await insertProduct();
      await expect(insertVariant(product, { variant_model: 'single' })).rejects.toMatchObject({
        code: '23503',
      });
      await expect(insertVariant(uuid7())).rejects.toMatchObject({ code: '23503' });
      await expect(
        insertVariant(product, { market_id: otherMarketOf(code) }),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('refuses an inconsistent variant state', async () => {
      const product = await insertProduct();
      await expect(insertVariant(product, { state: 'retired' })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(insertVariant(product, { state: 'published' })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(insertVariant(product, { state: 'other' })).rejects.toMatchObject({
        code: '23514',
      });
    });

    it('guards the variant registry: no revival, no way back, no delete, no identity change', async () => {
      const product = await insertProduct();
      const proposed = await insertVariant(product);
      const published = await insertVariant(product, {
        state: 'published',
        published_at: T0.toString(),
      });
      const retired = await insertVariant(product, { state: 'retired', retired_at: T0.toString() });

      const set = (id: string, clause: string, values: unknown[] = []) =>
        sqlState(owner, `UPDATE catalog.product_variants SET ${clause} WHERE id = $1`, [
          id,
          ...values,
        ]);

      expect(
        await set(retired, `state = 'published', retired_at = NULL, published_at = now()`),
      ).toBe('23001');
      expect(await set(retired, `retired_at = now()`)).toBe('23001');
      expect(await set(published, `state = 'proposed'`)).toBe('23001');
      expect(await set(proposed, `product_id = $2`, [uuid7()])).toBe('23001');
      expect(await set(proposed, `created_at = now()`)).toBe('23001');
      expect(
        await sqlState(owner, `DELETE FROM catalog.product_variants WHERE id = $1`, [retired]),
      ).toBe('23001');
      expect(
        await sqlState(app, `DELETE FROM catalog.product_variants WHERE id = $1`, [retired]),
      ).toBe('42501');
      expect(await set(proposed, `state = 'published', published_at = now()`)).toBeNull();
      expect(await set(published, `state = 'retired', retired_at = now()`)).toBeNull();
    });

    it('retires a single variant only together with a discarded product', async () => {
      const product = await insertProduct({ type_code: 'simple', variant_model: 'single' });
      const variant = await insertVariant(product, { variant_model: 'single' });
      const retire = () =>
        sqlState(
          app,
          `UPDATE catalog.product_variants SET state = 'retired', retired_at = now() WHERE id = $1`,
          [variant],
        );

      expect(await retire()).toBe('23514');
      await app.query(
        `UPDATE catalog.products SET status = 'discarded', discarded_at = now(), version = 2 WHERE id = $1`,
        [product],
      );
      expect(await retire()).toBeNull();
    });

    it('keeps the outbox append-only for the application but for the relay mark', async () => {
      expect(await sqlState(app, `UPDATE catalog.outbox SET payload = '{}' WHERE false`)).toBe(
        '42501',
      );
      expect(await sqlState(app, `DELETE FROM catalog.outbox WHERE false`)).toBe('42501');
      expect(
        await sqlState(app, `UPDATE catalog.outbox SET published_at = now() WHERE false`),
      ).toBeNull();
      expect(await sqlState(app, `UPDATE catalog.inbox SET handler = 'x' WHERE false`)).toBe(
        '42501',
      );
    });

    it('refuses an outbox row of another module and a counter below one', async () => {
      const row = `INSERT INTO catalog.outbox (event_id, type, occurred_at, market_id, tenant_id, aggregate_type, aggregate_id, aggregate_version, correlation_id, payload)
                   VALUES ($1, $2, now(), $3, $4, 'product', $5, 1, 'db-test-correlation-1', '{}')`;
      const args = (type: string) => [uuid7(), type, market.marketId, market.tenantId, uuid7()];
      expect(await sqlState(app, row, args('sellers.variant-added.v1'))).toBe('23514');
      expect(await sqlState(app, row, args('catalog.variant-added.v1'))).toBeNull();
      expect(
        await sqlState(
          app,
          `UPDATE catalog.product_code_counters SET next_value = 0 WHERE market_id = $1`,
          [market.marketId],
        ),
      ).toBe('23514');
    });
  });
});
