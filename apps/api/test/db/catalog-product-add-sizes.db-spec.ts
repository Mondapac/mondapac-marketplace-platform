import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  recordDriverStatements,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Add sizes on PostgreSQL (catalog data design 3.1, 3.2, 3.7; migration
// 20261106210000_catalog_product_add_sizes), for both Market fixtures: the type moves once, simple
// to configurable together with variant_model, and the single variant follows by cascade; the
// variant guard refuses the way back; revisions carry type_code; the new sensitive reason and
// rate-counter kind are accepted.

const T0 = Temporal.Instant.from('2026-11-06T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('Add sizes in market %s (database)', (code) => {
  const market = marketOf(code);
  let db: Persistence;
  let owner: Client;
  let app: Client;
  let products: PrismaProductRepository;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    app = new Client({ connectionString: testDatabaseUrl() });
    await app.connect();
    products = new PrismaProductRepository(db.service);
  });
  afterAll(async () => {
    await app.end();
    await owner.end();
    await db.close();
  });

  async function newProduct(): Promise<{ id: Id<'Product'>; variantId: Id<'Variant'> }> {
    const variantId = uuid7() as Id<'Variant'>;
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: market.marketId,
      scope: 'PLATFORM',
      sellerId: null,
      handler: simpleProductType,
      familyCode: 'default',
      productCode: `A${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
      variantId,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    await db.unitOfWork.run(market, async () => ok(await products.add(market, created.value)));
    return { id: created.value.state.id, variantId };
  }

  const productRow = async (id: string) =>
    (
      await owner.query(
        'SELECT type_code, variant_model, version FROM catalog.products WHERE market_id = $1 AND id = $2',
        [market.marketId, id],
      )
    ).rows[0] as { type_code: string; variant_model: string; version: number };
  const variantRow = async (id: string) =>
    (
      await owner.query(
        'SELECT id, variant_no, variant_model FROM catalog.product_variants WHERE market_id = $1 AND product_id = $2',
        [market.marketId, id],
      )
    ).rows as { id: string; variant_no: number; variant_model: string }[];
  /** The SQLSTATE, message and constraint of a statement that must fail. */
  const failure = async (
    statement: Promise<unknown>,
  ): Promise<{ code?: string; message: string; constraint?: string }> => {
    try {
      await statement;
    } catch (error) {
      return error as { code?: string; message: string; constraint?: string };
    }
    throw new Error('the statement was accepted');
  };
  const setType = (id: string, type: string, model: string) =>
    app.query(
      'UPDATE catalog.products SET type_code = $3, variant_model = $4 WHERE market_id = $1 AND id = $2',
      [market.marketId, id, type, model],
    );

  it('moves a Simple product to Configurable once, and the single variant follows', async () => {
    const { id, variantId } = await newProduct();
    const before = await variantRow(id);
    await setType(id, 'configurable', 'options');
    expect(await productRow(id)).toMatchObject({
      type_code: 'configurable',
      variant_model: 'options',
    });
    expect(await variantRow(id)).toEqual([{ ...before[0], variant_model: 'options' }]);
    expect((await variantRow(id))[0]!.id).toBe(variantId);
  });

  it('refuses the way back and a type change without the model', async () => {
    const { id } = await newProduct();
    const guard = {
      code: '23514',
      message: expect.stringContaining(
        'the type changes only from simple to configurable',
      ) as string,
    };
    expect(await failure(setType(id, 'configurable', 'single'))).toMatchObject(guard);
    expect(await failure(setType(id, 'other', 'options'))).toMatchObject(guard);
    await setType(id, 'configurable', 'options');
    expect(await failure(setType(id, 'simple', 'single'))).toMatchObject(guard);
    expect(await failure(setType(id, 'simple', 'options'))).toMatchObject(guard);
    expect(await productRow(id)).toMatchObject({
      type_code: 'configurable',
      variant_model: 'options',
    });
  });

  it('lets a same-value write through', async () => {
    const { id } = await newProduct();
    await setType(id, 'simple', 'single');
    expect(await productRow(id)).toMatchObject({ type_code: 'simple' });
  });

  it('refuses a variant going from options to single', async () => {
    const { id } = await newProduct();
    await setType(id, 'configurable', 'options');
    // restrict_violation (23001) from the variant guard, whoever the role is.
    expect(
      await failure(
        owner.query(
          "UPDATE catalog.product_variants SET variant_model = 'single' WHERE market_id = $1 AND product_id = $2",
          [market.marketId, id],
        ),
      ),
    ).toMatchObject({
      code: '23001',
      message: expect.stringContaining(
        'the variant model changes only from single to options',
      ) as string,
    });
    expect((await variantRow(id))[0]!.variant_model).toBe('options');
  });

  it('stores the domain change through the repository', async () => {
    const { id } = await newProduct();
    await db.unitOfWork.run(market, async () => {
      const product = (await products.findById(market, id))!;
      const changed = product.addSizes({
        authorKind: 'admin',
        replacePending: false,
        revertFamilyCode: 'default',
        now: T0,
      });
      if (!changed.ok) throw new Error(changed.error.code);
      await products.save(market, product);
      return ok(undefined);
    });
    const row = await productRow(id);
    expect(row).toMatchObject({ type_code: 'configurable', variant_model: 'options' });
    expect(row.version).toBeGreaterThan(1);
    const loaded = await db.unitOfWork.run(market, async () =>
      ok(await products.findById(market, id)),
    );
    expect(loaded.ok && loaded.value!.state).toMatchObject({
      typeCode: 'configurable',
      variantModel: 'options',
    });
  });

  /** A feature set revision for the product's Market, for the revision rows below. */
  async function familyRevisionFor(id: string): Promise<string> {
    const familyId = uuid7();
    const familyRevisionId = uuid7();
    await owner.query(
      `INSERT INTO catalog.attribute_families
         (id, market_id, tenant_id, code, status, created_by_kind, version, created_at)
       SELECT $1::uuid, $2::text, tenant_id, $3::text, 'active', 'seed', 1, now()
         FROM catalog.products WHERE market_id = $2::text AND id = $4::uuid`,
      [familyId, market.marketId, `s-${familyId.slice(-10)}`, id],
    );
    await owner.query(
      `INSERT INTO catalog.attribute_family_revisions
         (id, market_id, tenant_id, family_id, revision_no, groups, author_kind, created_at)
       SELECT $1::uuid, $2::text, tenant_id, $3::uuid, 1, '[]', 'seed', now()
         FROM catalog.products WHERE market_id = $2::text AND id = $4::uuid`,
      [familyRevisionId, market.marketId, familyId, id],
    );
    return familyRevisionId;
  }
  const insertRevision = (
    id: string,
    familyRevisionId: string,
    revisionNo: number,
    typeCode: string | null,
    reasons: string[],
    revisionId = uuid7(),
  ) =>
    owner.query(
      `INSERT INTO catalog.product_revisions
         (id, market_id, tenant_id, product_id, revision_no, revision_kind, family_revision_id,
          definition_revision_ids, tax_category_code, attribute_values, sensitive, sensitive_reasons,
          content_schema_version, content_hash, author_kind, author_account_id, submitted_at, type_code)
       SELECT $1::uuid, $2::text, p.tenant_id, p.id, $9::int, 'submission', $8::uuid, '{}', 'standard', '{}',
              true, $5::text[], 1, $6::text, 'admin', $7::uuid, now(), $4::text
         FROM catalog.products p
        WHERE p.market_id = $2::text AND p.id = $3::uuid`,
      [
        revisionId,
        market.marketId,
        id,
        typeCode,
        `{${reasons.join(',')}}`,
        `sha256:${'2'.repeat(64)}`,
        uuid7(),
        familyRevisionId,
        revisionNo,
      ],
    );

  it('keeps type_code on revisions: required, shaped, and insert-only', async () => {
    const { id } = await newProduct();
    const familyRevisionId = await familyRevisionFor(id);
    const missing = await failure(insertRevision(id, familyRevisionId, 1, null, ['axis-added']));
    expect(missing).toMatchObject({
      code: '23502',
      message: expect.stringContaining('type_code') as string,
    });
    const shaped = await failure(
      insertRevision(id, familyRevisionId, 1, 'Bad Code', ['axis-added']),
    );
    expect(shaped).toMatchObject({
      code: '23514',
      constraint: 'product_revisions_type_code_check',
    });
    await insertRevision(id, familyRevisionId, 1, 'simple', ['axis-added']);
    const update = await failure(
      owner.query(
        "UPDATE catalog.product_revisions SET type_code = 'configurable' WHERE market_id = $1 AND product_id = $2",
        [market.marketId, id],
      ),
    );
    expect(update).toMatchObject({
      code: '23001',
      message: 'catalog.product_revisions: append-only, UPDATE is not allowed',
    });
    const { rows } = await owner.query(
      'SELECT type_code FROM catalog.product_revisions WHERE market_id = $1 AND product_id = $2',
      [market.marketId, id],
    );
    expect(rows).toEqual([{ type_code: 'simple' }]);
  });

  it('accepts every review reason, the new one and each earlier one, and refuses any other', async () => {
    const { id } = await newProduct();
    const familyRevisionId = await familyRevisionFor(id);
    const reasons = [
      'platform-categories',
      'tax-category',
      'name',
      'primary-image',
      'image-added-or-replaced',
      'variant-removed',
      'gtin-changed',
      'axis-added',
      'never-published',
      'approval-required',
    ];
    let revisionNo = 0;
    for (const reason of reasons) {
      revisionNo += 1;
      await insertRevision(id, familyRevisionId, revisionNo, 'simple', [reason]);
    }
    // All of them together, and none.
    await insertRevision(id, familyRevisionId, revisionNo + 1, 'simple', reasons);
    await insertRevision(id, familyRevisionId, revisionNo + 2, 'simple', []);
    for (const bad of [['axis-removed'], ['axis-added', 'nope']]) {
      expect(
        await failure(insertRevision(id, familyRevisionId, revisionNo + 3, 'simple', bad)),
      ).toMatchObject({
        code: '23514',
        constraint: 'product_revisions_sensitive_reasons_check',
      });
    }
  });

  it('moves type, model, family and the pending pointer in one UPDATE (replacePending)', async () => {
    const { id, variantId } = await newProduct();
    // A pending revision, with the family it was submitted under.
    const familyRevisionId = await familyRevisionFor(id);
    const pendingId = uuid7();
    await insertRevision(id, familyRevisionId, 1, 'simple', [], pendingId);
    await app.query(
      `UPDATE catalog.products SET family_code = 'other', status = 'unpublished',
              pending_revision_id = $3, pending_submitted_at = now()
        WHERE market_id = $1 AND id = $2`,
      [market.marketId, id, pendingId],
    );

    const driver = recordDriverStatements();
    try {
      await driver.during(() =>
        db.unitOfWork.run(market, async () => {
          const product = (await products.findById(market, id))!;
          const changed = product.addSizes({
            authorKind: 'admin',
            replacePending: true,
            revertFamilyCode: 'default',
            now: T0,
          });
          if (!changed.ok) throw new Error(changed.error.code);
          expect(changed.value.supersededRevisionId).toBe(pendingId);
          await products.save(market, product);
          return ok(undefined);
        }),
      );
    } finally {
      driver.restore();
    }
    // One UPDATE of the product row carries all four columns, so both triggers
    // (products_family_follows_revision, products_type_change_guard) judged the same new row.
    const updates = driver.statements.filter((text) =>
      /^\s*update\s+"catalog"\."products"/i.test(text),
    );
    expect(updates).toHaveLength(1);
    for (const column of ['type_code', 'variant_model', 'family_code', 'pending_revision_id']) {
      expect(updates[0]).toContain(`"${column}"`);
    }

    const { rows } = await owner.query(
      `SELECT type_code, variant_model, family_code, status, pending_revision_id, pending_submitted_at
         FROM catalog.products WHERE market_id = $1 AND id = $2`,
      [market.marketId, id],
    );
    expect(rows[0]).toEqual({
      type_code: 'configurable',
      variant_model: 'options',
      family_code: 'default',
      status: 'unpublished',
      pending_revision_id: null,
      pending_submitted_at: null,
    });
    const variants = await variantRow(id);
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({ id: variantId, variant_model: 'options' });
    // The set-aside revision stays (insert-only), now no longer a pointer.
    const kept = await owner.query(
      'SELECT type_code FROM catalog.product_revisions WHERE market_id = $1 AND id = $2',
      [market.marketId, pendingId],
    );
    expect(kept.rows).toEqual([{ type_code: 'simple' }]);
  });

  it('accepts the add-sizes rate-counter kind', async () => {
    const { rows } = await owner.query(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'rate_counters_kind_check' AND conrelid = 'catalog.rate_counters'::regclass",
    );
    expect((rows[0] as { def: string }).def).toContain("'add-sizes.account.hour'");
  });
});
