import { randomUUID } from 'node:crypto';
import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, IdGenerator } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import ExcelJS from 'exceljs';
import { ExceljsSheetWriter } from '../../src/modules/catalog/infrastructure/xlsx/exceljs-sheet-writer';
import { ClaimQueryBuilder } from '../../src/modules/catalog/application/tags/claim-query-builder';
import { AdminProductPause } from '../../src/modules/catalog/application/use-cases/admin-product-pause.use-case';
import { AdminProductResume } from '../../src/modules/catalog/application/use-cases/admin-product-resume.use-case';
import { AdminProductWithdraw } from '../../src/modules/catalog/application/use-cases/admin-product-withdraw.use-case';
import { AdminProductsBulk } from '../../src/modules/catalog/application/use-cases/admin-products-bulk.use-case';
import { AdminProductsExport } from '../../src/modules/catalog/application/use-cases/admin-products-export.use-case';
import { OwnOfferAddTag } from '../../src/modules/catalog/application/use-cases/own-offer-add-tag.use-case';
import { PlatformProductRetire } from '../../src/modules/catalog/application/use-cases/platform-product-retire.use-case';
import { ConfigCatalogMarketPolicy } from '../../src/modules/catalog/infrastructure/config-catalog-market-policy';
import { PrismaAdminProductsReader } from '../../src/modules/catalog/infrastructure/prisma-admin-products.reader';
import { PrismaCategoryPathsReader } from '../../src/modules/catalog/infrastructure/prisma-category-paths.reader';
import { PrismaOfferRepository } from '../../src/modules/catalog/infrastructure/prisma-offer.repository';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaProductRevisionRepository } from '../../src/modules/catalog/infrastructure/prisma-product-revision.repository';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import {
  allowedDecision,
  FakeClaimEvaluator,
  RecordingOutbox,
  refusedDecision,
} from '../support/catalog-tag-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The admin product pause, resume, withdraw and retire, the Bulk action and the export on
// PostgreSQL, for both Market fixtures (catalog design 4.1, 4.1a, 9.2c; migration
// 20261031100000_catalog_product_pause): the mark and the stored cause in one unit, the Offers
// off sale and back through a fresh ask of every tag, the terminal Delete of a SELLER product
// (withdraw) and a PLATFORM one (retire, with the confirmed Offer count), per-product units in a
// bulk, the Market boundary and the file.

const T0 = '2026-10-30T00:00:00Z';
const HASH = `sha256:${'b'.repeat(64)}`;
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const ids: IdGenerator = { next: <K extends string>() => uuid7() as Id<K> };
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });

describe.each(TEST_MARKETS)('catalog product pause in market %s (database integration)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const typeCode = code === 'AU' ? 'halal' : 'zz-cert';
  const certificate = {
    certificateId: uuid7() as Id,
    versionId: uuid7() as Id,
    typeRevisionId: uuid7() as Id,
  };
  let owner: Client;
  let persistence: Persistence;
  let outbox: RecordingOutbox;
  let audits: AuditEntry[];

  beforeAll(async () => {
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    persistence = createPersistence();
  });
  afterAll(async () => {
    await owner.end();
    await persistence.close();
  });
  beforeEach(() => {
    outbox = new RecordingOutbox();
    audits = [];
  });

  const baseOf = (target: typeof market) => ({
    market_id: target.marketId,
    tenant_id: target.tenantId,
  });
  async function insert(table: string, row: Record<string, unknown>) {
    await owner.query(
      `INSERT INTO catalog.${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row)
        .map((_, i) => `$${i + 1}`)
        .join(', ')})`,
      Object.values(row),
    );
  }

  /** A published product with one revision, one variant and a name; answers its id. */
  async function product(
    scope: 'SELLER' | 'PLATFORM',
    options: { target?: typeof market; sellerId?: string; name?: string } = {},
  ) {
    const target = options.target ?? market;
    const base = baseOf(target);
    const sellerId = scope === 'SELLER' ? (options.sellerId ?? uuid7()) : null;
    const productId = uuid7();
    const variantId = uuid7();
    const familyId = uuid7();
    const familyRevisionId = uuid7();
    const revisionId = uuid7();
    await insert('products', {
      id: productId,
      ...base,
      scope,
      owner_seller_id: sellerId,
      created_by_seller_id: sellerId,
      type_code: 'simple',
      variant_model: 'single',
      family_code: 'default',
      product_code: `Z${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
      status: 'draft',
      own_brand: false,
      last_changed_at: T0,
      version: 1,
      created_at: T0,
    });
    await insert('product_variants', {
      id: variantId,
      ...base,
      product_id: productId,
      variant_model: 'single',
      state: 'published',
      created_at: T0,
      published_at: T0,
    });
    await insert('attribute_families', {
      id: familyId,
      ...base,
      code: `f-${randomUUID().slice(0, 10)}`,
      status: 'active',
      created_by_kind: 'seed',
      version: 1,
      created_at: T0,
    });
    await insert('attribute_family_revisions', {
      id: familyRevisionId,
      ...base,
      family_id: familyId,
      revision_no: 1,
      groups: '[]',
      author_kind: 'seed',
      created_at: T0,
    });
    await insert('product_revisions', {
      id: revisionId,
      ...base,
      product_id: productId,
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
      content_hash: HASH,
      author_kind: 'seller',
      author_account_id: uuid7(),
      acting_admin_account_id: null,
      submitted_at: T0,
    });
    await insert('product_revision_texts', {
      ...base,
      revision_id: revisionId,
      locale: policy.locales(target).default,
      name: options.name ?? 'Dates',
      short_description: null,
      description: null,
    });
    await insert('product_revision_variants', {
      ...base,
      revision_id: revisionId,
      variant_id: variantId,
      product_id: productId,
      position: 0,
      option_key: '',
      option_values: '{}',
      labels: '{}',
    });
    await owner.query(
      `UPDATE catalog.products SET status = 'published', published_revision_id = $2, version = 2
        WHERE id = $1`,
      [productId, revisionId],
    );
    return { productId: productId as Id<'Product'>, sellerId };
  }

  async function offerOn(productId: string, sellerId: string | null = null, status = 'published') {
    const id = uuid7();
    const seller = sellerId ?? uuid7();
    const published = status === 'published';
    await insert('offers', {
      id,
      ...baseOf(market),
      seller_id: seller,
      product_id: productId,
      seller_sku: `SKU-${randomUUID().slice(0, 13)}`,
      condition_code: 'new',
      description: '{}',
      handling: 'SEALED_ORIGINAL',
      attestation_recorded_at: null,
      attestation_account_id: null,
      status,
      off_sale_type_not_allowed: false,
      off_sale_product_retired: false,
      off_sale_product_not_listed: false,
      off_sale_tag_suspended: false,
      off_sale_product_paused: false,
      off_sale_description_claim_text: false,
      listed: published,
      submitted_at: published ? T0 : null,
      first_published_at: published ? T0 : null,
      deleted_at: status === 'deleted' ? T0 : null,
      version: 1,
      created_at: T0,
    });
    return { offerId: id as Id<'Offer'>, sellerId: seller as Id<'Seller'> };
  }

  const admin = (target: typeof market = market): CallContext =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population: 'admin',
        accountId: uuid7() as Id<'Account'>,
        sessionId: uuid7() as Id<'Session'>,
        sellerId: null,
      }),
    );
  const sellerContext = (sellerId: Id<'Seller'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: uuid7() as Id<'Account'>,
        sessionId: uuid7() as Id<'Session'>,
        sellerId,
      }),
    );

  const claims = () =>
    new ClaimQueryBuilder({
      products: new PrismaProductRepository(persistence.service),
      revisions: new PrismaProductRevisionRepository(persistence.service),
      categoryPaths: new PrismaCategoryPathsReader(persistence.service),
    });
  const allowing = () =>
    new FakeClaimEvaluator((query) => allowedDecision(query, certificate), [typeCode]);

  function stack(evaluator: FakeClaimEvaluator = allowing()) {
    const base = {
      unitOfWork: persistence.unitOfWork,
      products: new PrismaProductRepository(persistence.service),
      offers: new PrismaOfferRepository(persistence.service, ids),
      outbox,
      audit: {
        record: (_context: CallContext, entry: AuditEntry) => {
          audits.push(entry);
          return Promise.resolve();
        },
      },
      clock: new FixedClock(Temporal.Instant.from('2026-10-30T02:00:00Z')),
    };
    const pause = new AdminProductPause(gate, base);
    const resume = new AdminProductResume(gate, { ...base, claims: claims(), evaluator });
    const withdraw = new AdminProductWithdraw(gate, base);
    const retire = new PlatformProductRetire(gate, base);
    const reader = new PrismaAdminProductsReader(persistence.service);
    const bulk = new AdminProductsBulk(gate, {
      unitOfWork: persistence.unitOfWork,
      adminProductsReader: reader,
      policy,
      pause,
      resume,
      withdraw,
      retire,
    });
    const exporter = new AdminProductsExport(gate, {
      unitOfWork: persistence.unitOfWork,
      adminProductsReader: reader,
      policy,
      sellerNames: { storeNames: () => Promise.resolve(new Map()) },
      sheetWriter: new ExceljsSheetWriter(),
      clock: base.clock,
    });
    return { pause, resume, withdraw, retire, bulk, exporter, evaluator };
  }

  async function productRow(productId: string) {
    const { rows } = await owner.query<{
      status: string;
      paused_at: Date | null;
      paused_by_account_id: string | null;
      version: number;
    }>(
      `SELECT status, paused_at, paused_by_account_id, version FROM catalog.products
        WHERE market_id = $1 AND id = $2`,
      [market.marketId, productId],
    );
    return rows[0]!;
  }
  async function offerRow(offerId: string) {
    const { rows } = await owner.query<{
      status: string;
      listed: boolean;
      off_sale_product_paused: boolean;
      off_sale_product_retired: boolean;
      off_sale_tag_suspended: boolean;
      version: number;
    }>(
      `SELECT status, listed, off_sale_product_paused, off_sale_product_retired,
              off_sale_tag_suspended, version
         FROM catalog.offers WHERE market_id = $1 AND id = $2`,
      [market.marketId, offerId],
    );
    return rows[0]!;
  }
  async function historyKinds(offerId: string) {
    const { rows } = await owner.query<{ change_kind: string; listed: boolean }>(
      `SELECT change_kind, listed FROM catalog.offer_history
        WHERE market_id = $1 AND offer_id = $2 ORDER BY offer_version`,
      [market.marketId, offerId],
    );
    return rows;
  }

  describe('pause', () => {
    it('marks the product and takes every Offer off sale in one unit, then audits it', async () => {
      const { productId } = await product('SELLER');
      const a = await offerOn(productId);
      const b = await offerOn(productId);
      const draft = await offerOn(productId, null, 'draft');
      const gone = await offerOn(productId, null, 'deleted');
      const { pause } = stack();
      const context = admin();

      const result = await pause.execute(context, { productId });

      expect(result).toEqual({ ok: true, value: { productId, offerCount: 3 } });
      const row = await productRow(productId);
      expect(row).toMatchObject({ status: 'published', version: 3 });
      expect(row.paused_at).not.toBeNull();
      expect(row.paused_by_account_id).toBe(
        context.actor.kind === 'authenticated' ? context.actor.accountId : null,
      );
      for (const { offerId } of [a, b]) {
        expect(await offerRow(offerId)).toMatchObject({
          listed: false,
          off_sale_product_paused: true,
        });
        expect((await historyKinds(offerId)).map((h) => h.change_kind)).toContain('causes-changed');
      }
      // A draft has the cause too (so a later publish stays off sale); it was never listed.
      expect(await offerRow(draft.offerId)).toMatchObject({
        listed: false,
        off_sale_product_paused: true,
      });
      // A deleted Offer is left alone.
      expect(await offerRow(gone.offerId)).toMatchObject({ off_sale_product_paused: false });
      expect(outbox.types.filter((t) => t === 'catalog.product-paused.v1')).toHaveLength(1);
      expect(outbox.types.filter((t) => t === 'catalog.offer-listing-changed.v1')).toHaveLength(2);
      expect(audits.map((entry) => entry.action)).toEqual(['catalog.product.paused']);
    });

    it('refuses a second pause and a product that is not published, changing nothing', async () => {
      const { productId } = await product('SELLER');
      await offerOn(productId);
      const { pause } = stack();
      expect((await pause.execute(admin(), { productId })).ok).toBe(true);
      const before = await productRow(productId);
      outbox.appended.length = 0;

      expect(await pause.execute(admin(), { productId })).toEqual({
        ok: false,
        error: { code: 'product.already-paused' },
      });
      await owner.query(
        `UPDATE catalog.products SET status = 'unpublished', paused_at = NULL, paused_by_account_id = NULL
          WHERE id = $1`,
        [productId],
      );
      expect(await pause.execute(admin(), { productId })).toEqual({
        ok: false,
        error: { code: 'product.not-published' },
      });

      expect((await productRow(productId)).version).toBe(before.version);
      expect(outbox.appended).toEqual([]);
    });

    it('answers product.not-found for an id of another Market and for an unknown id', async () => {
      const foreign = await product('SELLER', { target: other });
      const { pause } = stack();

      expect(await pause.execute(admin(), { productId: foreign.productId })).toEqual({
        ok: false,
        error: { code: 'product.not-found' },
      });
      expect(await pause.execute(admin(), { productId: uuid7() })).toEqual({
        ok: false,
        error: { code: 'product.not-found' },
      });
      expect(await pause.execute(admin(), { productId: 'not-an-id' })).toEqual({
        ok: false,
        error: { code: 'product.not-found' },
      });
      const { rows } = await owner.query(
        `SELECT 1 FROM catalog.products WHERE id = $1 AND paused_at IS NOT NULL`,
        [foreign.productId],
      );
      expect(rows).toEqual([]);
    });

    it('is refused for a seller session', async () => {
      const { productId, sellerId } = await product('SELLER');
      const { pause } = stack();

      expect(await pause.execute(sellerContext(sellerId as Id<'Seller'>), { productId })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect((await productRow(productId)).paused_at).toBeNull();
    });
  });

  describe('resume', () => {
    it('clears the mark and the cause, and puts the Offers back on sale', async () => {
      const { productId } = await product('PLATFORM');
      const a = await offerOn(productId);
      const { pause, resume } = stack();
      await pause.execute(admin(), { productId });
      outbox.appended.length = 0;
      audits.length = 0;

      const result = await resume.execute(admin(), { productId });

      expect(result).toEqual({ ok: true, value: { productId, offerCount: 1 } });
      expect(await productRow(productId)).toMatchObject({
        status: 'published',
        paused_at: null,
        paused_by_account_id: null,
      });
      expect(await offerRow(a.offerId)).toMatchObject({
        listed: true,
        off_sale_product_paused: false,
      });
      expect(outbox.types).toEqual(
        expect.arrayContaining(['catalog.product-resumed.v1', 'catalog.offer-listing-changed.v1']),
      );
      expect(audits.map((entry) => entry.action)).toEqual(['catalog.product.resumed']);
      expect(await resume.execute(admin(), { productId })).toEqual({
        ok: false,
        error: { code: 'product.not-paused' },
      });
    });

    it('asks every kept tag again: an allowed tag stays, a refused one keeps the Offer off sale', async () => {
      const { productId } = await product('PLATFORM');
      const kept = await offerOn(productId);
      const lost = await offerOn(productId);
      const adding = new OwnOfferAddTag(gate, {
        unitOfWork: persistence.unitOfWork,
        offers: new PrismaOfferRepository(persistence.service, ids),
        eligibility: { isEligible: () => Promise.resolve(true) },
        save: { reserveSaves: () => Promise.resolve(null) },
        claims: claims(),
        evaluator: allowing(),
        outbox,
        clock: new FixedClock(Temporal.Instant.from(T0)),
        ids,
      });
      for (const { offerId, sellerId } of [kept, lost]) {
        expect(await adding.execute(sellerContext(sellerId), { offerId, typeCode })).toMatchObject({
          ok: true,
        });
      }
      const refusing = new FakeClaimEvaluator(
        (query) =>
          query.sellerId === lost.sellerId
            ? refusedDecision(query, 'attestation-missing')
            : allowedDecision(query, certificate),
        [typeCode],
      );
      const { pause, resume } = stack(refusing);
      expect((await pause.execute(admin(), { productId })).ok).toBe(true);

      const result = await resume.execute(admin(), { productId });

      expect(result).toEqual({ ok: true, value: { productId, offerCount: 2 } });
      expect(refusing.calls.length).toBeGreaterThan(0);
      expect(await offerRow(kept.offerId)).toMatchObject({
        listed: true,
        off_sale_product_paused: false,
        off_sale_tag_suspended: false,
      });
      // The tag no longer holds: the Offer stays off sale for that cause alone.
      expect(await offerRow(lost.offerId)).toMatchObject({
        listed: false,
        off_sale_product_paused: false,
        off_sale_tag_suspended: true,
      });
    });

    it('fails closed while certification is unavailable: still paused, nothing changed', async () => {
      const { productId } = await product('PLATFORM');
      const a = await offerOn(productId);
      const adding = new OwnOfferAddTag(gate, {
        unitOfWork: persistence.unitOfWork,
        offers: new PrismaOfferRepository(persistence.service, ids),
        eligibility: { isEligible: () => Promise.resolve(true) },
        save: { reserveSaves: () => Promise.resolve(null) },
        claims: claims(),
        evaluator: allowing(),
        outbox,
        clock: new FixedClock(Temporal.Instant.from(T0)),
        ids,
      });
      expect(
        await adding.execute(sellerContext(a.sellerId), { offerId: a.offerId, typeCode }),
      ).toMatchObject({ ok: true });
      const down = allowing();
      down.unavailable = true;
      const { pause, resume } = stack(down);
      await pause.execute(admin(), { productId });

      expect(await resume.execute(admin(), { productId })).toEqual({
        ok: false,
        error: { code: 'claim.check-unavailable' },
      });

      expect((await productRow(productId)).paused_at).not.toBeNull();
      expect(await offerRow(a.offerId)).toMatchObject({
        listed: false,
        off_sale_product_paused: true,
      });
    });
  });

  describe('delete', () => {
    it('withdraws a SELLER product, terminally: the Offers are deleted and the product is gone from Active', async () => {
      const { productId } = await product('SELLER');
      const a = await offerOn(productId);
      const { withdraw, pause } = stack();
      // A paused product can be withdrawn too.
      await pause.execute(admin(), { productId });

      const result = await withdraw.execute(admin(), { productId });

      expect(result).toMatchObject({ ok: true });
      expect(await productRow(productId)).toMatchObject({
        status: 'withdrawn',
        paused_at: null,
        paused_by_account_id: null,
      });
      expect(await offerRow(a.offerId)).toMatchObject({ status: 'deleted', listed: false });
      expect(audits.map((entry) => entry.action)).toContain('catalog.product.withdrawn');
      expect(await withdraw.execute(admin(), { productId })).toEqual({
        ok: false,
        error: { code: 'product.not-withdrawable' },
      });
    });

    it('refuses to withdraw a PLATFORM product and to retire a SELLER product', async () => {
      const platform = await product('PLATFORM');
      const seller = await product('SELLER');
      const { withdraw, retire } = stack();

      expect(await withdraw.execute(admin(), { productId: platform.productId })).toEqual({
        ok: false,
        error: { code: 'product.seller-only' },
      });
      expect(
        await retire.execute(admin(), { productId: seller.productId, confirmOfferCount: 0 }),
      ).toEqual({ ok: false, error: { code: 'product.platform-only' } });
    });

    it('retires a PLATFORM product only with the confirmed Offer count, and sets the cause', async () => {
      const { productId } = await product('PLATFORM');
      const a = await offerOn(productId);
      const b = await offerOn(productId);
      await offerOn(productId, null, 'deleted');
      const { retire } = stack();

      expect(await retire.execute(admin(), { productId, confirmOfferCount: 1 })).toEqual({
        ok: false,
        error: { code: 'retire.count-changed', currentCount: 2 },
      });
      expect((await productRow(productId)).status).toBe('published');

      const result = await retire.execute(admin(), { productId, confirmOfferCount: 2 });

      expect(result).toMatchObject({ ok: true });
      expect(await productRow(productId)).toMatchObject({ status: 'retired' });
      for (const { offerId } of [a, b]) {
        expect(await offerRow(offerId)).toMatchObject({
          status: 'published',
          listed: false,
          off_sale_product_retired: true,
        });
      }
      expect(audits.map((entry) => entry.action)).toContain('catalog.product.retired');
    });
  });

  describe('bulk', () => {
    it('pauses many products, one unit each, and reports the one it skipped', async () => {
      const a = await product('SELLER');
      const b = await product('PLATFORM');
      const already = await product('SELLER');
      await offerOn(a.productId);
      const { bulk, pause } = stack();
      await pause.execute(admin(), { productId: already.productId });

      const result = await bulk.execute(admin(), {
        action: 'pause',
        productIds: [a.productId, b.productId, already.productId],
      });

      expect(result).toMatchObject({
        ok: true,
        value: {
          requested: 3,
          counts: { done: 2, skipped: 1, failed: 0 },
          results: [
            { productId: a.productId, outcome: 'done' },
            { productId: b.productId, outcome: 'done' },
            { productId: already.productId, outcome: 'skipped', reason: 'product.already-paused' },
          ],
        },
      });
      expect((await productRow(a.productId)).paused_at).not.toBeNull();
      expect((await productRow(b.productId)).paused_at).not.toBeNull();
    });

    it('refuses the whole request for an id of another Market, before it changes anything', async () => {
      const mine = await product('SELLER');
      const foreign = await product('SELLER', { target: other });
      const { bulk } = stack();

      expect(
        await bulk.execute(admin(), {
          action: 'pause',
          productIds: [mine.productId, foreign.productId],
        }),
      ).toEqual({ ok: false, error: { code: 'product.not-found' } });
      expect((await productRow(mine.productId)).paused_at).toBeNull();
    });

    it('deletes SELLER and PLATFORM products in one request: dry run, then the confirmed count', async () => {
      const seller = await product('SELLER');
      const platform = await product('PLATFORM');
      await offerOn(seller.productId);
      await offerOn(platform.productId);
      await offerOn(platform.productId);
      const { bulk } = stack();
      const productIds = [seller.productId, platform.productId];

      const dry = await bulk.execute(admin(), { action: 'delete', productIds, dryRun: true });
      expect(dry).toMatchObject({
        ok: true,
        value: { eligible: 2, confirmOfferCount: 2, affectedOfferCount: 3 },
      });
      expect((await productRow(platform.productId)).status).toBe('published');

      expect(await bulk.execute(admin(), { action: 'delete', productIds })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(
        await bulk.execute(admin(), { action: 'delete', productIds, confirmOfferCount: 5 }),
      ).toEqual({ ok: false, error: { code: 'retire.count-changed', currentCount: 2 } });

      const done = await bulk.execute(admin(), {
        action: 'delete',
        productIds,
        confirmOfferCount: 2,
      });

      expect(done).toMatchObject({
        ok: true,
        value: { counts: { done: 2, skipped: 0, failed: 0 } },
      });
      expect((await productRow(seller.productId)).status).toBe('withdrawn');
      expect((await productRow(platform.productId)).status).toBe('retired');
    });

    it('works on a selector: the products of the Inactive tab, a filter on the seller', async () => {
      const mine = uuid7();
      const a = await product('SELLER', { sellerId: mine });
      const b = await product('SELLER', { sellerId: mine });
      const { bulk, pause } = stack();
      await pause.execute(admin(), { productId: a.productId });

      const resumed = await bulk.execute(admin(), {
        action: 'resume',
        selector: { view: 'inactive', sellerId: mine },
      });

      expect(resumed).toMatchObject({
        ok: true,
        value: { requested: 1, counts: { done: 1 } },
      });
      expect((await productRow(a.productId)).paused_at).toBeNull();
      expect((await productRow(b.productId)).paused_at).toBeNull();
    });
  });

  describe('export', () => {
    async function fileOf(input: Record<string, unknown>): Promise<string> {
      const { exporter } = stack();
      const answer = await exporter.execute(admin(), input);
      if (!answer.ok) throw new Error(JSON.stringify(answer.error));
      let text = '';
      for await (const chunk of answer.value.chunks) {
        text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      }
      return text;
    }

    it('streams the chosen products as CSV with the status as the list shows it', async () => {
      const mine = uuid7();
      const live = await product('SELLER', { sellerId: mine, name: 'Plain dates' });
      const paused = await product('SELLER', { sellerId: mine, name: 'Paused dates' });
      await offerOn(live.productId);
      await offerOn(live.productId);
      const { pause } = stack();
      await pause.execute(admin(), { productId: paused.productId });

      const text = await fileOf({
        ids: `${live.productId},${paused.productId}`,
        columns: 'offers,scope',
      });

      const lines = text.replace(/^\uFEFF/, '').split('\r\n');
      expect(lines[0]).toBe('Product,Product code,Category,Status,Offers,Scope');
      expect(lines[1]).toMatch(/^Plain dates,Z[A-Z0-9]+,,Active,2,Seller$/);
      expect(lines[2]).toMatch(/^Paused dates,Z[A-Z0-9]+,,Inactive,0,Seller$/);
      expect(lines[3]).toBe('');
    });

    it('guards a name that a spreadsheet would run as a formula', async () => {
      const evil = await product('SELLER', { name: '=HYPERLINK("http://evil","x")' });

      const text = await fileOf({ ids: evil.productId });

      expect(text).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    });

    it('streams the same products as an XLSX workbook, every cell a string', async () => {
      const mine = uuid7();
      const live = await product('SELLER', { sellerId: mine, name: 'Plain dates' });
      const evil = await product('SELLER', {
        sellerId: mine,
        name: '=HYPERLINK("http://evil","x")',
      });
      await offerOn(live.productId);
      const { exporter } = stack();

      const answer = await exporter.execute(admin(), {
        format: 'xlsx',
        ids: `${live.productId},${evil.productId}`,
        columns: 'offers,scope',
      });
      if (!answer.ok) throw new Error(JSON.stringify(answer.error));
      expect(answer.value.contentType).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(answer.value.filename).toMatch(/^products-\d{4}-\d{2}-\d{2}\.xlsx$/);
      const parts: Uint8Array[] = [];
      for await (const chunk of answer.value.chunks) parts.push(chunk as Uint8Array);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Buffer.concat(parts) as never);
      const sheet = workbook.worksheets[0]!;
      const rows: string[][] = [];
      sheet.eachRow((row) => {
        const cells: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell) => cells.push(cell.text));
        rows.push(cells);
      });
      expect(rows[0]).toEqual(['Product', 'Product code', 'Category', 'Status', 'Offers', 'Scope']);
      expect(rows[1]).toEqual([
        'Plain dates',
        expect.stringMatching(/^Z[A-Z0-9]+$/),
        '',
        'Active',
        '1',
        'Seller',
      ]);
      expect(rows[2]![0]).toBe('=HYPERLINK("http://evil","x")');
      sheet.eachRow((row) =>
        row.eachCell((cell) => expect(cell.type).toBe(ExcelJS.ValueType.String)),
      );
    });

    it('exports a selector and refuses an id of another Market and an unknown format', async () => {
      const mine = uuid7();
      await product('SELLER', { sellerId: mine });
      await product('SELLER', { sellerId: mine });
      const foreign = await product('SELLER', { target: other });
      const { exporter } = stack();

      const text = await fileOf({ view: 'all', sellerId: mine });
      expect(text.replace(/^\uFEFF/, '').split('\r\n')).toHaveLength(4);
      for (const format of [undefined, 'csv', 'xlsx']) {
        expect(
          await exporter.execute(admin(), {
            ...(format ? { format } : {}),
            ids: foreign.productId,
          }),
        ).toEqual({ ok: false, error: { code: 'product.not-found' } });
      }
      expect(
        await exporter.execute(admin(), { format: 'xls', ids: foreign.productId }),
      ).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    });
  });
});
