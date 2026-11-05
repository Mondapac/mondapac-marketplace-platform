import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { CategorySlugResolveQuery } from '../../src/modules/catalog/application/use-cases/category-slug-resolve.use-case';
import { PublicCategoryTreeQuery } from '../../src/modules/catalog/application/use-cases/public-category-tree.use-case';
import { PlatformCategory } from '../../src/modules/catalog/domain/platform-category';
import { ConfigCatalogMarketPolicy } from '../../src/modules/catalog/infrastructure/config-catalog-market-policy';
import { PrismaCategoryTreeReader } from '../../src/modules/catalog/infrastructure/prisma-category-tree.reader';
import { PrismaPlatformCategoryRepository } from '../../src/modules/catalog/infrastructure/prisma-platform-category.repository';
import { PrismaPublicCategoryReader } from '../../src/modules/catalog/infrastructure/prisma-public-category.reader';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The buyer site's category reads on PostgreSQL, as the application role, for both Market
// fixtures (categories package C6a): the public tree in the admin's order with the menu switch,
// SEO fields, per-locale short descriptions and "has live products" (a published, not paused
// product with a listed Offer); and the `/c/{slug}` resolver over the slug history, merges,
// archives and hidden categories. Another Market's category is never answered.

const T0 = Temporal.Instant.from('2026-11-05T00:00:00Z');
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const HASH = `sha256:${'c'.repeat(64)}`;
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);

describe.each(TEST_MARKETS)('catalog public categories in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const anonymous = testCallContext(market, 'anonymous', `c6a-anon-${code.toLowerCase()}abcdef`);
  const policy = new ConfigCatalogMarketPolicy(markets);
  const locale = policy.locales(market).default;
  let db: Persistence;
  let owner: Client;
  let categories: PrismaPlatformCategoryRepository;
  let tree: PublicCategoryTreeQuery;
  let resolver: CategorySlugResolveQuery;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    categories = new PrismaPlatformCategoryRepository(db.service);
    const deps = {
      unitOfWork: db.unitOfWork,
      treeReader: new PrismaCategoryTreeReader(db.service),
      publicCategories: new PrismaPublicCategoryReader(db.service),
      policy,
    };
    tree = new PublicCategoryTreeQuery(gate, deps);
    resolver = new CategorySlugResolveQuery(gate, deps);
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  const write = async <T>(target: MarketContext, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const insert = async (table: string, row: Record<string, unknown>) => {
    const columns = Object.keys(row);
    await owner.query(
      `INSERT INTO catalog.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  };
  const base = (target: MarketContext) => ({
    market_id: target.marketId,
    tenant_id: target.tenantId,
  });
  const sql = (text: string, values: unknown[]) => owner.query(text, values);

  interface Made {
    readonly id: Id<'Category'>;
    readonly slug: string;
    readonly revisionId: string;
  }

  async function category(
    target: MarketContext,
    parentId: string | null,
    name: string,
  ): Promise<Made> {
    const slug = `pc-${uuid7().slice(-12)}`;
    const revisionId = uuid7();
    const created = PlatformCategory.create({
      id: uuid7() as Id<'Category'>,
      revisionId: revisionId as Id<'CategoryRevision'>,
      marketId: target.marketId,
      parentId: parentId as Id<'Category'> | null,
      verticalRootCode: null,
      slug,
      names: [{ locale, name }],
      createdByKind: 'seed',
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    await write(target, () => categories.add(target, created.value));
    return { id: created.value.state.id, slug, revisionId };
  }

  /**
   * A new revision of a category with the given names and short descriptions, made the published
   * one when `publish` is true (else it stays a revision nobody published).
   */
  async function revise(
    target: MarketContext,
    made: Made,
    texts: { locale: string; name: string; shortDescription: string | null }[],
    publish: boolean,
  ): Promise<void> {
    const revisionId = uuid7();
    const { rows } = await sql(
      `SELECT coalesce(max(revision_no), 0) + 1 AS next, max(parent_id::text) AS parent
         FROM catalog.platform_category_revisions WHERE market_id = $1 AND category_id = $2`,
      [target.marketId, made.id],
    );
    const next = (rows[0] as { next: number; parent: string | null }).next;
    const parent = (rows[0] as { next: number; parent: string | null }).parent;
    await insert('platform_category_revisions', {
      id: revisionId,
      ...base(target),
      category_id: made.id,
      revision_no: next,
      parent_id: parent,
      change_kind: 'renamed',
      author_kind: 'seed',
      author_account_id: null,
      created_at: T0.toString(),
      reason: null,
    });
    for (const text of texts) {
      await insert('platform_category_revision_texts', {
        ...base(target),
        revision_id: revisionId,
        locale: text.locale,
        name: text.name,
        short_description: text.shortDescription,
        keywords: [],
      });
      await insert('platform_category_revision_names', {
        ...base(target),
        revision_id: revisionId,
        locale: text.locale,
        name: text.name,
      });
    }
    if (publish) {
      await sql(
        `UPDATE catalog.platform_categories SET published_revision_id = $3
           WHERE market_id = $1 AND id = $2`,
        [target.marketId, made.id, revisionId],
      );
    }
  }

  /** A published product on `categoryId` with one Offer, listed or not; paused when asked. */
  async function product(
    target: MarketContext,
    categoryId: string,
    {
      listed = true,
      paused = false,
      earlierOn,
    }: { listed?: boolean; paused?: boolean; earlierOn?: string } = {},
  ): Promise<void> {
    const familyId = uuid7();
    const familyRevisionId = uuid7();
    await insert('attribute_families', {
      id: familyId,
      ...base(target),
      code: `f-${uuid7().slice(-10)}`,
      status: 'active',
      created_by_kind: 'seed',
      version: 1,
      created_at: T0.toString(),
    });
    await insert('attribute_family_revisions', {
      id: familyRevisionId,
      ...base(target),
      family_id: familyId,
      revision_no: 1,
      groups: '[]',
      author_kind: 'seed',
      created_at: T0.toString(),
    });
    const productId = uuid7();
    const revisionId = uuid7();
    const revision = (id: string, revisionNo: number) =>
      insert('product_revisions', {
        id,
        ...base(target),
        product_id: productId,
        revision_no: revisionNo,
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
        author_kind: 'admin',
        author_account_id: uuid7(),
        acting_admin_account_id: null,
        submitted_at: T0.toString(),
      });
    await insert('products', {
      id: productId,
      ...base(target),
      scope: 'PLATFORM',
      owner_seller_id: null,
      created_by_seller_id: null,
      type_code: 'simple',
      variant_model: 'single',
      family_code: 'default',
      product_code: `P${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
      status: 'draft',
      own_brand: false,
      last_changed_at: T0.toString(),
      version: 1,
      created_at: T0.toString(),
    });
    if (earlierOn !== undefined) {
      // An earlier revision on another category: it was never the published one.
      const earlierId = uuid7();
      await revision(earlierId, 1);
      await insert('product_revision_categories', {
        ...base(target),
        revision_id: earlierId,
        category_id: earlierOn,
        position: 0,
      });
    }
    await revision(revisionId, earlierOn === undefined ? 1 : 2);
    await insert('product_revision_categories', {
      ...base(target),
      revision_id: revisionId,
      category_id: categoryId,
      position: 0,
    });
    await sql(
      `UPDATE catalog.products SET status = 'published', published_revision_id = $3
         WHERE market_id = $1 AND id = $2`,
      [target.marketId, productId, revisionId],
    );
    if (paused) {
      await sql(
        `UPDATE catalog.products SET paused_at = $3, paused_by_account_id = $4
           WHERE market_id = $1 AND id = $2`,
        [target.marketId, productId, T0.toString(), uuid7()],
      );
    }
    await insert('offers', {
      id: uuid7(),
      ...base(target),
      seller_id: uuid7(),
      product_id: productId,
      seller_sku: `SKU-${uuid7().slice(-12)}`,
      condition_code: 'new',
      description: '{}',
      handling: 'SEALED_ORIGINAL',
      attestation_recorded_at: null,
      attestation_account_id: null,
      status: 'published',
      off_sale_type_not_allowed: false,
      off_sale_product_retired: false,
      off_sale_product_not_listed: !listed,
      off_sale_product_paused: false,
      off_sale_tag_suspended: false,
      off_sale_description_claim_text: false,
      listed,
      submitted_at: T0.toString(),
      first_published_at: T0.toString(),
      deleted_at: null,
      version: 1,
      created_at: T0.toString(),
    });
  }

  const setStatus = (target: MarketContext, id: string, status: string, mergedInto?: string) =>
    sql(
      `UPDATE catalog.platform_categories SET status = $3, merged_into_id = $4
         WHERE market_id = $1 AND id = $2`,
      [target.marketId, id, status, mergedInto ?? null],
    );

  const publicTree = async (asked?: string) => {
    const result = await tree.execute(anonymous, asked === undefined ? {} : { locale: asked });
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  };

  it("answers the tree in the admin's order with menu, SEO, texts and live products", async () => {
    const root = await category(market, null, 'Pantry');
    const alpha = await category(market, root.id, 'Alpha');
    const beta = await category(market, root.id, 'Beta');
    const gamma = await category(market, root.id, 'Gamma');
    const deep = await category(market, gamma.id, 'Deep');
    // Alpha moves to the end: the order is Beta, Gamma, Alpha whatever the names say.
    await sql(
      `UPDATE catalog.platform_categories SET position = 50 WHERE market_id = $1 AND id = $2`,
      [market.marketId, alpha.id],
    );
    await sql(
      `UPDATE catalog.platform_categories
          SET show_in_menu = false, seo_title = 'Beta', seo_description = 'All beta', seo_noindex = true
        WHERE market_id = $1 AND id = $2`,
      [market.marketId, beta.id],
    );
    await insert('platform_category_revision_texts', {
      ...base(market),
      revision_id: root.revisionId,
      locale: 'fa-IR',
      name: 'انبار',
      short_description: 'همه چیز برای آشپزخانه',
      keywords: [],
    });
    await product(market, deep.id);
    await product(market, beta.id);
    await product(market, alpha.id, { listed: false });
    await product(market, alpha.id, { paused: true });
    const elsewhere = await category(other, null, 'Elsewhere');
    await product(other, elsewhere.id);

    const answer = await publicTree('fa-IR');
    const supported = policy.locales(market).supported.includes('fa-IR');
    const mine = answer.categories.filter((c) =>
      [root, alpha, beta, gamma, deep].some((made) => made.id === c.id),
    );

    expect(answer.locale).toBe(supported ? 'fa-IR' : locale);
    expect(answer.defaultLocale).toBe(locale);
    expect(mine.map((c) => c.slug)).toEqual([
      root.slug,
      beta.slug,
      gamma.slug,
      deep.slug,
      alpha.slug,
    ]);
    const bySlug = new Map(mine.map((c) => [c.slug, c]));
    expect(bySlug.get(root.slug)).toMatchObject({
      hasLiveProducts: true,
      inMenu: true,
      shortDescription: supported ? 'همه چیز برای آشپزخانه' : null,
      imageUrl: null,
    });
    expect(bySlug.get(beta.slug)).toMatchObject({
      showInMenu: false,
      inMenu: false,
      hasLiveProducts: true,
      seo: { title: 'Beta', description: 'All beta', noindex: true },
    });
    expect(bySlug.get(gamma.slug)).toMatchObject({ hasLiveProducts: true, inMenu: true });
    // An unlisted Offer and a paused product are not live.
    expect(bySlug.get(alpha.slug)).toMatchObject({ hasLiveProducts: false, inMenu: false });
  });

  it('answers names and short descriptions per locale with the default-locale fallback', async () => {
    const second = policy.locales(market).supported.find((l) => l !== locale);
    const root = await category(market, null, 'Root');
    const both = await category(market, root.id, 'Both');
    const defaultOnly = await category(market, root.id, 'Default only');
    await revise(
      market,
      both,
      [
        { locale, name: 'Both', shortDescription: 'Default text' },
        ...(second === undefined
          ? []
          : [{ locale: second, name: 'Both second', shortDescription: 'Second text' }]),
      ],
      true,
    );
    await revise(
      market,
      defaultOnly,
      [{ locale, name: 'Default only', shortDescription: 'Only default' }],
      true,
    );

    const answer = await publicTree(second);
    const bySlug = new Map(answer.categories.map((c) => [c.slug, c]));

    expect(bySlug.get(both.slug)).toMatchObject(
      second === undefined
        ? { name: 'Both', shortDescription: 'Default text' }
        : { name: 'Both second', shortDescription: 'Second text' },
    );
    expect(bySlug.get(defaultOnly.slug)).toMatchObject({
      name: 'Default only',
      shortDescription: 'Only default',
    });
  });

  it('reads published content only: a draft revision and an earlier product revision do not count', async () => {
    const root = await category(market, null, 'Root');
    const drafted = await category(market, root.id, 'Drafted');
    const earlier = await category(market, root.id, 'Earlier');
    const now = await category(market, root.id, 'Now');
    await revise(
      market,
      drafted,
      [{ locale, name: 'Draft name', shortDescription: 'Draft text' }],
      false,
    );
    await product(market, now.id, { earlierOn: earlier.id });

    const bySlug = new Map((await publicTree()).categories.map((c) => [c.slug, c]));

    expect(bySlug.get(drafted.slug)).toMatchObject({ name: 'Drafted', shortDescription: null });
    expect(bySlug.get(earlier.slug)?.hasLiveProducts).toBe(false);
    expect(bySlug.get(now.slug)?.hasLiveProducts).toBe(true);
  });

  it.each(['//evil.com', '\\evil.com', '%2F%2Fevil.com', 'https://evil.com'])(
    'answers not found for %j through the real reads',
    async (slug) => {
      const result = await resolver.execute(anonymous, { slug });

      expect(result.ok ? result.value : result.error).toEqual({
        code: 'catalog.category-not-found',
      });
    },
  );

  it('falls back to the default locale for a locale the Market does not support', async () => {
    const answer = await publicTree('xx-XX');

    expect(answer.locale).toBe(locale);
  });

  it('resolves live slugs, the slug history, merges, archives and hidden categories', async () => {
    const root = await category(market, null, 'Root');
    const target = await category(market, root.id, 'Target');
    const merged = await category(market, root.id, 'Merged');
    const mergedTwice = await category(market, root.id, 'Merged twice');
    const archived = await category(market, root.id, 'Archived');
    const hidden = await category(market, root.id, 'Hidden');
    const underHidden = await category(market, hidden.id, 'Under hidden');
    await setStatus(market, merged.id, 'merged', target.id);
    await setStatus(market, mergedTwice.id, 'merged', merged.id);
    await setStatus(market, archived.id, 'archived');
    await setStatus(market, hidden.id, 'hidden');
    const retired = `pc-old-${uuid7().slice(-8)}`;
    await insert('platform_category_slug_history', {
      ...base(market),
      slug: retired,
      category_id: mergedTwice.id,
      retired_at: T0.toString(),
    });
    const resolve = async (slug: string) => {
      const result = await resolver.execute(anonymous, { slug });
      return result.ok ? result.value : result.error;
    };

    expect(await resolve(target.slug)).toEqual({
      kind: 'category',
      id: target.id,
      slug: target.slug,
    });
    // History, then two merges: one hop to the end of the chain.
    expect(await resolve(retired)).toEqual({
      kind: 'redirect',
      slug: target.slug,
      permanent: true,
    });
    expect(await resolve(mergedTwice.slug)).toEqual({
      kind: 'redirect',
      slug: target.slug,
      permanent: true,
    });
    expect(await resolve(archived.slug)).toEqual({
      kind: 'redirect',
      slug: root.slug,
      permanent: true,
    });
    expect(await resolve(hidden.slug)).toEqual({
      kind: 'redirect',
      slug: root.slug,
      permanent: false,
    });
    expect(await resolve(underHidden.slug)).toEqual({
      kind: 'redirect',
      slug: root.slug,
      permanent: false,
    });
    expect(await resolve('pc-never-made')).toEqual({ code: 'catalog.category-not-found' });
  });

  it("answers not found for another Market's live slug and slug history", async () => {
    const canary = await category(other, null, 'Canary');
    const retired = `pc-zz-${uuid7().slice(-8)}`;
    await insert('platform_category_slug_history', {
      ...base(other),
      slug: retired,
      category_id: canary.id,
      retired_at: T0.toString(),
    });

    for (const slug of [canary.slug, retired]) {
      const result = await resolver.execute(anonymous, { slug });
      expect(result.ok ? result.value : result.error).toEqual({
        code: 'catalog.category-not-found',
      });
    }
    const answer = await publicTree();
    expect(answer.categories.some((c) => c.id === canary.id)).toBe(false);
  });
});
