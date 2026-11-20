import { devNull } from 'node:os';
import type { INestApplicationContext, InjectionToken } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pino from 'pino';
import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { AuditEntry, Id, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { AppModule } from '../../src/app.module';
import {
  AttributeActionApplier,
  CategoryActionApplier,
  FeatureSetCreateApplier,
  ProductsMoveApplier,
  type CatalogueStructureDependencies,
} from '../../src/modules/catalog/application/catalogue-appliers';
import { isProposal } from '../../src/modules/catalog/application/catalogue-review';
import {
  AttributeCreateReverter,
  CategoryCreateReverter,
  CategoryMoveReverter,
  CategoryReorderReverter,
} from '../../src/modules/catalog/application/catalogue-structure-reverters';
import { ADMIN_CATEGORY_READER } from '../../src/modules/catalog/application/ports/admin-category.reader';
import { ATTRIBUTE_ADMIN_READER } from '../../src/modules/catalog/application/ports/attribute-admin.reader';
import { ATTRIBUTE_DEFINITION_STORE } from '../../src/modules/catalog/application/ports/attribute-definition.store';
import { ATTRIBUTE_IMPACT_READER } from '../../src/modules/catalog/application/ports/attribute-impact.reader';
import { ATTRIBUTE_RELAXATION_STORE } from '../../src/modules/catalog/application/ports/attribute-relaxation.store';
import {
  CATEGORY_EDIT_STORE,
  CATEGORY_RESTRUCTURE_STORE,
} from '../../src/modules/catalog/application/ports/category-edit.store';
import { CATEGORY_PRODUCT_MOVE_STORE } from '../../src/modules/catalog/application/ports/category-product-move.store';
import type { ClaimTermLocales } from '../../src/modules/catalog/application/ports/claim-term-locales';
import type { ClaimTextMatcher } from '../../src/modules/catalog/application/ports/claim-text-matcher';
import { FEATURE_SET_STORE } from '../../src/modules/catalog/application/ports/feature-set.store';
import { OFFER_REPOSITORY } from '../../src/modules/catalog/application/ports/offer.repository';
import { PLATFORM_CATEGORY_REPOSITORY } from '../../src/modules/catalog/application/ports/platform-category.repository';
import { TAG_REEVALUATION_REQUESTS } from '../../src/modules/catalog/application/ports/tag-reevaluation-requests';
import { AttributeArchive } from '../../src/modules/catalog/application/use-cases/attribute-archive.use-case';
import { AttributeDefinitionCreate } from '../../src/modules/catalog/application/use-cases/attribute-definition-create.use-case';
import { AttributeDefinitionDiscard } from '../../src/modules/catalog/application/use-cases/attribute-definition-discard.use-case';
import { AttributeDefinitionPublish } from '../../src/modules/catalog/application/use-cases/attribute-definition-publish.use-case';
import { AttributeMerge } from '../../src/modules/catalog/application/use-cases/attribute-merge.use-case';
import { AttributeValuesMerge } from '../../src/modules/catalog/application/use-cases/attribute-values-merge.use-case';
import { CategoryArchive } from '../../src/modules/catalog/application/use-cases/category-archive.use-case';
import { CategoryCreate } from '../../src/modules/catalog/application/use-cases/category-create.use-case';
import { CategoryDiscard } from '../../src/modules/catalog/application/use-cases/category-discard.use-case';
import { CategoryMerge } from '../../src/modules/catalog/application/use-cases/category-merge.use-case';
import { CategoryMove } from '../../src/modules/catalog/application/use-cases/category-move.use-case';
import { CategoryMoveProducts } from '../../src/modules/catalog/application/use-cases/category-move-products.use-case';
import { FeatureSetCreate } from '../../src/modules/catalog/application/use-cases/feature-set-create.use-case';
import { CategoryReorder } from '../../src/modules/catalog/application/use-cases/category-reorder.use-case';
import { CatalogModule } from '../../src/modules/catalog/catalog.module';
import { ConfigCatalogMarketPolicy } from '../../src/modules/catalog/infrastructure/config-catalog-market-policy';
import {
  SYSTEM_ACTION_PROPOSER,
  SYSTEM_REQUEST_RECORDER,
  SystemRequestsModule,
  type SystemActionProposer,
  type SystemRequestRecorder,
} from '../../src/modules/system-requests';
import {
  REQUEST_REPOSITORY,
  type RequestRepository,
} from '../../src/modules/system-requests/application/ports/request.repository';
import { AUDIT_WRITER, type AuditWriter } from '../../src/platform/audit/audit-writer';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { ContentFilter } from '../../src/platform/content-filter/content-filter';
import { OUTBOX_WRITER } from '../../src/platform/events/outbox-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import {
  testAppConfig,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../support/test-config';
import { marketOf } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// Structure changes of area catalogue (Admin Inbox › System requests, owner decision of 18 Nov
// 2026) on the real proposer, recorder and catalog stores, in both Market fixtures (catalogue is
// reviewed by default): a discard or an archive files a proposal (approval mode) and writes nothing
// in catalog; its applier then writes it in the decision's unit, as the approving admin, naming
// the request, and answers changed-since the second time. A create or reorder applies at once and
// opens a review; its reverter undoes it. Records are new per test (and the tree version is read
// again on a race), so nothing here meets another spec's rows. The attribute and feature-set
// cases write their events to the real catalog outbox; a category restructure (move, merge,
// archive) keeps its events in memory, for the outbox reason given at the archive case below.
// Each L1 check here is made by the deciding admin's context (Hassan L1).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);

describe.each(TEST_MARKETS)('catalogue structure requests in market %s (database)', (code) => {
  const market = marketOf(code);
  const english = policy.locales(market).default;
  const clock = new FixedClock(Temporal.Instant.from('2026-11-18T10:00:00Z'));
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const admin = (name: string) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
      name,
    );

  let app: INestApplicationContext;
  let unitOfWork: UnitOfWork;
  let requests: RequestRepository;
  let sql: Client;
  /** The database owner, for the rows no use case here writes (published products, seeds). */
  let owner: Client;
  let deps: CatalogueStructureDependencies & {
    readonly review: SystemRequestRecorder;
    readonly proposer: SystemActionProposer;
    readonly contentFilter: ContentFilter;
  };
  const audits: AuditEntry[] = [];
  const matcher: ClaimTextMatcher = {
    match: (_context, texts) => Promise.resolve(ok(texts.map(() => []))),
  };
  const claimLocales: ClaimTermLocales = {
    covered: () =>
      Promise.resolve(ok(['en-AU', 'en-US', 'ja-JP', ...policy.locales(market).supported])),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({ DATABASE_URL: testDatabaseUrl() }),
          logDestination: pino.destination(devNull),
        }),
      ],
    }).compile();
    app = await moduleRef.init();
    const catalog = app.select(CatalogModule);
    const port = <T>(token: InjectionToken): T => catalog.get<T>(token, { strict: true });
    const reviews = app.select(SystemRequestsModule);
    const realAudit = port<AuditWriter>(AUDIT_WRITER);
    unitOfWork = app.get<UnitOfWork>(UNIT_OF_WORK);
    requests = reviews.get<RequestRepository>(REQUEST_REPOSITORY, { strict: true });
    deps = {
      unitOfWork,
      store: port(CATEGORY_EDIT_STORE),
      restructure: port(CATEGORY_RESTRUCTURE_STORE),
      categories: port(PLATFORM_CATEGORY_REPOSITORY),
      policy,
      // Certification's check of retired categories is its own spec's; nothing here is claimed.
      retirement: {
        assertRetirable: () => Promise.resolve(ok(undefined)),
        retired: () => Promise.resolve(ok(undefined)),
      },
      offers: port(OFFER_REPOSITORY),
      requests: port(TAG_REEVALUATION_REQUESTS),
      audit: {
        record: (context, entry) => {
          audits.push(entry);
          return realAudit.record(context, entry);
        },
      },
      outbox: port(OUTBOX_WRITER),
      clock,
      ids,
      attributeStore: port(ATTRIBUTE_DEFINITION_STORE),
      relaxations: port(ATTRIBUTE_RELAXATION_STORE),
      impact: port(ATTRIBUTE_IMPACT_READER),
      featureSetStore: port(FEATURE_SET_STORE),
      attributeAdminReader: port(ATTRIBUTE_ADMIN_READER),
      matcher,
      claimLocales,
      moveStore: port(CATEGORY_PRODUCT_MOVE_STORE),
      adminCategoryReader: port(ADMIN_CATEGORY_READER),
      authorisation: { check: () => Promise.resolve({ allowed: true }) },
      review: reviews.get<SystemRequestRecorder>(SYSTEM_REQUEST_RECORDER, { strict: true }),
      proposer: reviews.get<SystemActionProposer>(SYSTEM_ACTION_PROPOSER, { strict: true }),
      contentFilter: new ContentFilter(markets),
    };
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
    await sql.end();
    await app.close();
  });

  const inUnit = async <T>(work: () => Promise<T>): Promise<T> => {
    const result = await unitOfWork.run(market, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  /** A write that names the tree version: read it again when another spec raised it meanwhile. */
  const atTreeVersion = async <T, E>(
    run: (treeVersion: number) => Promise<Result<T, E>>,
  ): Promise<Result<T, E>> => {
    for (let attempt = 1; ; attempt += 1) {
      const { version } = await inUnit(() => deps.categories.treeVersion(market));
      const answer = await run(version);
      const stale = !answer.ok && (answer.error as { code?: string }).code === 'conflict.stale';
      if (!stale || attempt >= 5) return answer;
    }
  };
  const slugOf = (): string =>
    `cs-${uuidV7(Date.now(), crypto.getRandomValues(new Uint8Array(10))).slice(-12)}`;
  const categoryOf = async (id: string) =>
    (
      await sql.query<{ status: string; position: number; version: number }>(
        'SELECT status, position, version FROM catalog.platform_categories WHERE id = $1',
        [id],
      )
    ).rows[0]!;
  const attributeStatus = async (id: string) =>
    (
      await sql.query<{ status: string }>(
        'SELECT status FROM catalog.attribute_definitions WHERE id = $1',
        [id],
      )
    ).rows[0]!.status;
  const requestRef = (
    request: { id: Id<'SystemRequest'> },
    subjectRef: string,
    stored: { before: unknown; after: unknown },
  ) => ({
    requestId: request.id,
    subjectRef,
    before: stored.before as never,
    after: stored.after as never,
  });

  /** A new hidden root category, created by the use case with its review; id and request. */
  async function newCategory(note = 'A new aisle') {
    const created = await atTreeVersion((treeVersion) =>
      new CategoryCreate(gate, deps).execute(admin('structure-db-create'), {
        slug: slugOf(),
        texts: { [english]: { name: `Aisle ${slugOf()}` } },
        treeVersion,
        note,
      }),
    );
    if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
    return created.value;
  }

  const HASH = `sha256:${'c'.repeat(64)}`;
  const insert = async (table: string, row: Record<string, unknown>) => {
    const columns = Object.keys(row);
    await owner.query(
      `INSERT INTO catalog.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  };
  const rowBase = () => ({ market_id: market.marketId, tenant_id: market.tenantId });
  const now = clock.now().toString();

  /** A published PLATFORM product whose published revision names `categoryId` (as the move spec). */
  async function publishedProductIn(categoryId: string): Promise<string> {
    const familyId = ids.next<'AttributeFamily'>();
    const familyRevisionId = ids.next<'AttributeFamilyRevision'>();
    await insert('attribute_families', {
      id: familyId,
      ...rowBase(),
      code: `f-${slugOf()}`,
      status: 'active',
      created_by_kind: 'seed',
      version: 1,
      created_at: now,
    });
    await insert('attribute_family_revisions', {
      id: familyRevisionId,
      ...rowBase(),
      family_id: familyId,
      revision_no: 1,
      groups: '[]',
      author_kind: 'seed',
      created_at: now,
    });
    const productId = ids.next<'Product'>();
    const revisionId = ids.next<'ProductRevision'>();
    await insert('products', {
      id: productId,
      ...rowBase(),
      scope: 'PLATFORM',
      owner_seller_id: null,
      created_by_seller_id: null,
      type_code: 'simple',
      variant_model: 'single',
      family_code: 'default',
      product_code: `S${productId.replaceAll('-', '').slice(-12).toUpperCase()}`,
      status: 'draft',
      own_brand: false,
      last_changed_at: now,
      version: 1,
      created_at: now,
    });
    await insert('product_revisions', {
      id: revisionId,
      ...rowBase(),
      product_id: productId,
      revision_no: 1,
      type_code: 'simple',
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
      author_account_id: ids.next<'Account'>(),
      acting_admin_account_id: null,
      submitted_at: now,
    });
    const variantId = ids.next<'ProductVariant'>();
    await insert('product_variants', {
      id: variantId,
      ...rowBase(),
      product_id: productId,
      variant_model: 'single',
      variant_no: 1,
      state: 'published',
      created_at: now,
      published_at: now,
    });
    await insert('product_revision_texts', {
      ...rowBase(),
      revision_id: revisionId,
      locale: 'en',
      name: 'Rice',
      short_description: null,
      description: null,
    });
    await insert('product_revision_variants', {
      ...rowBase(),
      revision_id: revisionId,
      variant_id: variantId,
      product_id: productId,
      position: 0,
      option_key: '',
      option_values: '{}',
      labels: '{}',
    });
    await insert('product_revision_categories', {
      ...rowBase(),
      revision_id: revisionId,
      category_id: categoryId,
      position: 0,
    });
    await owner.query(
      `UPDATE catalog.products SET status = 'published', published_revision_id = $3
         WHERE market_id = $1 AND id = $2`,
      [market.marketId, productId, revisionId],
    );
    return productId;
  }

  /** A published Offer of a new seller on `productId`, listed or not. */
  async function offerOn(productId: string, listed: boolean): Promise<void> {
    await insert('offers', {
      id: ids.next<'Offer'>(),
      ...rowBase(),
      seller_id: ids.next<'Seller'>(),
      product_id: productId,
      seller_sku: `SKU-${slugOf()}`,
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
      submitted_at: now,
      first_published_at: now,
      deleted_at: null,
      version: 1,
      created_at: now,
    });
  }

  it('reviews a create after: the request is open, and its reject discards the category', async () => {
    const created = await newCategory();
    const id = created.category.id;
    expect(created.request).not.toBeNull();
    const stored = await inUnit(() => requests.find(market, created.request!.id));
    expect(stored).toMatchObject({
      status: 'open',
      mode: 'review',
      area: 'catalogue',
      subjectKind: 'catalog.category-create',
      subjectRef: id,
      before: { exists: false },
      after: { exists: true, parentId: null },
    });
    expect(await categoryOf(id)).toMatchObject({ status: 'hidden' });
    const reverter = new CategoryCreateReverter(deps);
    const request = requestRef(created.request!, id, stored!);
    const reviewer = admin('structure-db-reviewer');
    expect(await reverter.check(reviewer)).toBe('ok');
    expect(await inUnit(() => reverter.revert(reviewer, request))).toBe('reverted');
    expect(await categoryOf(id)).toMatchObject({ status: 'archived' });
    expect(audits.at(-1)).toMatchObject({
      action: 'catalog.platform-category.discarded',
      targetId: id,
      after: { requestId: created.request!.id },
    });
  });

  it('files a discard for approval, writing nothing, and its approval discards the category', async () => {
    const { category } = await newCategory();
    const before = await categoryOf(category.id);
    const proposed = await atTreeVersion((treeVersion) =>
      new CategoryDiscard(gate, deps).execute(admin('structure-db-discard'), {
        categoryId: category.id,
        treeVersion,
        note: 'Made by mistake',
      }),
    );
    if (!proposed.ok || !isProposal(proposed.value)) {
      throw new Error('no proposal');
    }
    const proposal = proposed.value.request;
    const requestId = proposal.id;
    expect(await categoryOf(category.id)).toEqual(before);
    const stored = await inUnit(() => requests.find(market, requestId));
    expect(stored).toMatchObject({
      status: 'open',
      mode: 'approval',
      subjectKind: 'catalog.category-discard',
      subjectRef: category.id,
      before: { status: 'hidden', version: before.version, parentId: null },
      after: { action: 'discard' },
    });
    const again = await atTreeVersion((treeVersion) =>
      new CategoryDiscard(gate, deps).execute(admin('structure-db-discard-2'), {
        categoryId: category.id,
        treeVersion,
        note: 'Again',
      }),
    );
    expect(!again.ok && again.error).toMatchObject({ code: 'system-requests.already-pending' });

    const applier = new CategoryActionApplier(deps, ['discard']);
    const request = requestRef(proposal, category.id, stored!);
    const approver = admin('structure-db-approver');
    expect(await applier.check(approver, request)).toBe('ok');
    expect(await inUnit(() => applier.apply(approver, request))).toBe('applied');
    expect(await categoryOf(category.id)).toMatchObject({ status: 'archived' });
    expect(audits.at(-1)).toMatchObject({
      action: 'catalog.platform-category.discarded',
      targetId: category.id,
      after: { requestId },
    });
    expect(await inUnit(() => applier.apply(approver, request))).toBe('changed-since');
  });

  it('files an archive for approval, and its approval archives the category', async () => {
    const { category } = await newCategory();
    // The events of a restructure are kept here, as catalog-category-restructure.db-spec.ts does:
    // a restructure appends `platform-category-changed` and `platform-category-archived` for the
    // same category version, which the catalog outbox's unique (aggregate id, version) refuses on
    // the route as well (known, reported separately; not changed by the approval).
    const events: unknown[] = [];
    const restructureDeps = {
      ...deps,
      outbox: {
        append: (_context: unknown, batch: readonly unknown[]) => {
          events.push(...batch);
          return Promise.resolve();
        },
      },
    };
    const proposed = await atTreeVersion((treeVersion) =>
      new CategoryArchive(gate, restructureDeps).execute(admin('structure-db-archive'), {
        categoryId: category.id,
        treeVersion,
        reason: 'The aisle is closing for good',
      }),
    );
    if (!proposed.ok || !isProposal(proposed.value)) {
      throw new Error('no proposal');
    }
    const proposal = proposed.value.request;
    expect(await categoryOf(category.id)).toMatchObject({ status: 'hidden' });
    const stored = await inUnit(() => requests.find(market, proposal.id));
    // The reason is the reviewer's note when no note is given.
    expect(stored).toMatchObject({
      mode: 'approval',
      subjectKind: 'catalog.category-restructure',
      after: { action: 'archive', reason: 'The aisle is closing for good' },
    });
    const applier = new CategoryActionApplier(restructureDeps, ['merge', 'archive']);
    const request = requestRef(proposal, category.id, stored!);
    const approver = admin('structure-db-approver');
    expect(await applier.check(approver, request)).toBe('ok');
    expect(events).toEqual([]);
    expect(await inUnit(() => applier.apply(approver, request))).toBe('applied');
    expect(await categoryOf(category.id)).toMatchObject({ status: 'archived' });
    expect(events).toHaveLength(2);
    expect(audits.at(-1)).toMatchObject({
      action: 'catalog.platform-category.archived',
      after: { requestId: proposal.id },
    });
  });

  /**
   * The deps of a category restructure with its events kept in memory: a restructure appends
   * `platform-category-changed` and its own event for the same category version, which the catalog
   * outbox's unique (aggregate id, version) refuses (known, being fixed separately; see the
   * archive case above).
   */
  const withRecordingOutbox = () => {
    const events: unknown[] = [];
    return {
      events,
      deps: {
        ...deps,
        outbox: {
          append: (_context: unknown, batch: readonly unknown[]) => {
            events.push(...batch);
            return Promise.resolve();
          },
        },
      },
    };
  };

  it('files a merge for approval, writing nothing, and its approval merges the category', async () => {
    const source = await newCategory();
    const target = await newCategory();
    const { events, deps: restructureDeps } = withRecordingOutbox();
    const before = await categoryOf(source.category.id);
    const proposed = await atTreeVersion((treeVersion) =>
      new CategoryMerge(gate, restructureDeps).execute(admin('structure-db-merge'), {
        categoryId: source.category.id,
        targetId: target.category.id,
        treeVersion,
        reason: 'Two aisles became one',
        note: 'Same products in both',
      }),
    );
    if (!proposed.ok || !isProposal(proposed.value)) {
      throw new Error(`no proposal: ${proposed.ok ? 'applied' : proposed.error.code}`);
    }
    const proposal = proposed.value.request;
    expect(await categoryOf(source.category.id)).toEqual(before);
    expect(events).toEqual([]);
    const stored = await inUnit(() => requests.find(market, proposal.id));
    expect(stored).toMatchObject({
      status: 'open',
      mode: 'approval',
      subjectKind: 'catalog.category-restructure',
      subjectRef: source.category.id,
      after: { action: 'merge', targetId: target.category.id },
    });
    const applier = new CategoryActionApplier(restructureDeps, ['merge', 'archive']);
    const request = requestRef(proposal, source.category.id, stored!);
    const approver = admin('structure-db-approver');
    expect(await applier.check(approver, request)).toBe('ok');
    expect(await inUnit(() => applier.apply(approver, request))).toBe('applied');
    expect(await categoryOf(source.category.id)).toMatchObject({ status: 'merged' });
    expect(audits.at(-1)).toMatchObject({
      action: 'catalog.platform-category.merged',
      targetId: source.category.id,
      after: { requestId: proposal.id },
    });
    // A later decision does not find this check's result: it fails closed.
    expect(await inUnit(() => applier.apply(approver, request))).not.toBe('applied');
  });

  it('reviews a move after, and its reject moves the category back', async () => {
    const parent = await newCategory();
    const moving = await newCategory();
    const { deps: restructureDeps } = withRecordingOutbox();
    const moved = await atTreeVersion((treeVersion) =>
      new CategoryMove(gate, restructureDeps).execute(admin('structure-db-move'), {
        categoryId: moving.category.id,
        parentId: parent.category.id,
        treeVersion,
        reason: 'It belongs under the new aisle',
        note: 'Grouped with its aisle',
      }),
    );
    if (!moved.ok || moved.value.request === null) {
      throw new Error(`no review opened: ${moved.ok ? 'none' : moved.error.code}`);
    }
    const opened = moved.value.request;
    const parentOf = async () =>
      (
        await sql.query<{ parent_id: string | null }>(
          'SELECT parent_id FROM catalog.platform_categories WHERE id = $1',
          [moving.category.id],
        )
      ).rows[0]!.parent_id;
    expect(await parentOf()).toBe(parent.category.id);
    const stored = await inUnit(() => requests.find(market, opened.id));
    expect(stored).toMatchObject({
      status: 'open',
      mode: 'review',
      subjectKind: 'catalog.category-move',
      before: { parentId: null },
      after: { parentId: parent.category.id },
    });
    const reverter = new CategoryMoveReverter(restructureDeps);
    const request = requestRef(opened, moving.category.id, stored!);
    const reviewer = admin('structure-db-reviewer');
    expect(await reverter.check(reviewer, request)).toBe('ok');
    // Another admin's revert does not use this reviewer's check (Hassan L1).
    expect(await inUnit(() => reverter.revert(admin('structure-db-other'), request))).toBe(
      'not-permitted',
    );
    expect(await reverter.check(reviewer, request)).toBe('ok');
    expect(await inUnit(() => reverter.revert(reviewer, request))).toBe('reverted');
    expect(await parentOf()).toBeNull();
    expect(audits.at(-1)).toMatchObject({
      action: 'catalog.platform-category.moved',
      after: { requestId: opened.id },
    });
  });

  it('files a products move for approval, starting nothing, and its approval queues the job', async () => {
    // Department > group > source and target (products sit on level 3 and below).
    const department = await newCategory();
    const group = await atTreeVersion((treeVersion) =>
      new CategoryCreate(gate, deps).execute(admin('structure-db-create'), {
        parentId: department.category.id,
        slug: slugOf(),
        texts: { [english]: { name: `Group ${slugOf()}` } },
        treeVersion,
        note: 'A group',
      }),
    );
    if (!group.ok) throw new Error(group.error.code);
    const leaf = async () => {
      const created = await atTreeVersion((treeVersion) =>
        new CategoryCreate(gate, deps).execute(admin('structure-db-create'), {
          parentId: group.value.category.id,
          slug: slugOf(),
          texts: { [english]: { name: `Leaf ${slugOf()}` } },
          treeVersion,
          note: 'A leaf',
        }),
      );
      if (!created.ok) throw new Error(created.error.code);
      return created.value.category.id;
    };
    const source = await leaf();
    const target = await leaf();
    await publishedProductIn(source);
    await publishedProductIn(source);
    const jobsOf = async () =>
      (
        await owner.query<{ id: string; state: string; total: number }>(
          `SELECT id, state, total_count AS total FROM catalog.category_product_move_jobs
            WHERE market_id = $1 AND source_category_id = $2`,
          [market.marketId, source],
        )
      ).rows;

    const proposed = await new CategoryMoveProducts(gate, deps).execute(
      admin('structure-db-products'),
      { categoryId: source, targetId: target, reason: 'Basmati is its own aisle now' },
    );
    if (!proposed.ok || !isProposal(proposed.value)) {
      throw new Error(`no proposal: ${proposed.ok ? 'started' : proposed.error.code}`);
    }
    const proposal = proposed.value.request;
    expect(await jobsOf()).toEqual([]);
    const stored = await inUnit(() => requests.find(market, proposal.id));
    expect(stored).toMatchObject({
      status: 'open',
      mode: 'approval',
      subjectKind: 'catalog.category-products-move',
      subjectRef: source,
      after: { action: 'move-products', targetId: target, products: 2 },
    });
    const again = await new CategoryMoveProducts(gate, deps).execute(
      admin('structure-db-products-2'),
      { categoryId: source, targetId: target, reason: 'Basmati is its own aisle now' },
    );
    expect(!again.ok && again.error).toMatchObject({ code: 'system-requests.already-pending' });

    const applier = new ProductsMoveApplier(deps);
    const request = requestRef(proposal, source, stored!);
    const approver = admin('structure-db-approver');
    expect(await applier.check(approver)).toBe('ok');
    try {
      expect(await inUnit(() => applier.apply(approver, request))).toBe('applied');
      expect(await jobsOf()).toEqual([
        { id: <unknown>expect.any(String), state: 'queued', total: 2 },
      ]);
      expect(audits.at(-1)).toMatchObject({ after: { requestId: proposal.id } });
      // A second approval finds the job already open and starts no other.
      expect(await inUnit(() => applier.apply(approver, request))).toBe('not-permitted');
      expect(await jobsOf()).toHaveLength(1);
    } finally {
      // The job is the worker's, not this spec's: close it so no runner of another spec takes it.
      await owner.query(
        `UPDATE catalog.category_product_move_jobs
            SET state = 'done', started_at = COALESCE(started_at, now()), finished_at = now(),
                lease_holder = NULL, lease_expires_at = NULL
          WHERE market_id = $1 AND source_category_id = $2 AND state IN ('queued', 'running')`,
        [market.marketId, source],
      );
    }
  });

  it("counts a category request's impact on the real reads: its subtree's products and Offers, in its Market only", async () => {
    // Department > group > leaf: one product on the group, two on the leaf (one with two Offers).
    const department = await newCategory();
    const child = async (parentId: string, name: string) => {
      const created = await atTreeVersion((treeVersion) =>
        new CategoryCreate(gate, deps).execute(admin('structure-db-create'), {
          parentId,
          slug: slugOf(),
          texts: { [english]: { name: `${name} ${slugOf()}` } },
          treeVersion,
          note: `A ${name.toLowerCase()}`,
        }),
      );
      if (!created.ok) throw new Error(created.error.code);
      return created.value.category.id;
    };
    const group = await child(department.category.id, 'Group');
    const leaf = await child(group, 'Leaf');
    await publishedProductIn(group);
    const offered = await publishedProductIn(leaf);
    await publishedProductIn(leaf);
    await offerOn(offered, true);
    await offerOn(offered, false);
    const reviewer = admin('structure-db-impact');
    const ask = (subjectRef: string) => ({
      requestId: ids.next<'SystemRequest'>(),
      subjectRef,
      before: {},
      after: {},
    });
    const restructure = new CategoryActionApplier(deps, ['merge', 'archive']);
    expect(await restructure.impact(reviewer, ask(department.category.id))).toEqual({
      items: [
        { label: 'products', count: 3, atLeast: false },
        { label: 'offers', count: 2, atLeast: false },
        { label: 'offers-with-active-tag', count: 0, atLeast: false },
        { label: 'subcategories', count: 2, atLeast: false },
      ],
    });
    expect(await restructure.impact(reviewer, ask(leaf))).toEqual({
      items: [
        { label: 'products', count: 2, atLeast: false },
        { label: 'offers', count: 2, atLeast: false },
        { label: 'offers-with-active-tag', count: 0, atLeast: false },
        { label: 'subcategories', count: 0, atLeast: false },
      ],
    });
    // A products move takes the products that name the category itself.
    expect(await new ProductsMoveApplier(deps).impact(reviewer, ask(group))).toEqual({
      items: [{ label: 'products', count: 1, atLeast: false }],
    });
    // The other Market's reads never find this Market's category.
    const elsewhere = marketOf(TEST_MARKETS.find((other) => other !== code)!);
    const foreign = testCallContext(
      elsewhere,
      testAuthenticatedActor(elsewhere, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
      'structure-db-impact-elsewhere',
    );
    expect(await restructure.impact(foreign, ask(leaf))).toBeNull();
    expect(await new ProductsMoveApplier(deps).impact(foreign, ask(group))).toBeNull();
  });

  it('reviews a reorder after, and its reject puts the two siblings back', async () => {
    const first = await newCategory();
    const second = await newCategory();
    const parentless = [first.category.id, second.category.id];
    const positions = async () =>
      Promise.all(parentless.map(async (id) => (await categoryOf(id)).position));
    const start = await positions();
    const moved = await atTreeVersion((treeVersion) =>
      new CategoryReorder(gate, deps).execute(admin('structure-db-reorder'), {
        categoryId: second.category.id,
        direction: 'up',
        treeVersion,
        note: 'Second goes first',
      }),
    );
    if (!moved.ok || moved.value.request === null) throw new Error('no review opened');
    const opened = moved.value.request;
    expect(await positions()).toEqual([start[1], start[0]]);
    const stored = await inUnit(() => requests.find(market, opened.id));
    expect(stored).toMatchObject({ mode: 'review', subjectKind: 'catalog.category-reorder' });
    const reverter = new CategoryReorderReverter(deps);
    const request = requestRef(opened, second.category.id, stored!);
    const reviewer = admin('structure-db-reviewer');
    expect(await inUnit(() => reverter.revert(reviewer, request))).toBe('reverted');
    expect(await positions()).toEqual(start);
    expect(await inUnit(() => reverter.revert(reviewer, request))).toBe('changed-since');
  });

  describe('attributes', () => {
    const create = () => new AttributeDefinitionCreate(gate, deps);

    async function newAttribute() {
      const created = await create().execute(admin('structure-db-attribute'), {
        dataType: 'select',
        names: { [english]: `Pack ${slugOf()}` },
        options: [{ code: 'g500', labels: { [english]: '500 g' } }],
        note: 'For the pack sizes',
      });
      if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
      return created.value;
    }

    it('reviews a create after, and its reject discards the draft', async () => {
      const created = await newAttribute();
      const id = created.attribute.id;
      const stored = await inUnit(() => requests.find(market, created.request!.id));
      expect(stored).toMatchObject({
        mode: 'review',
        subjectKind: 'catalog.attribute-create',
        subjectRef: id,
        after: { exists: true, status: 'draft' },
      });
      const reverter = new AttributeCreateReverter(deps);
      const request = requestRef(created.request!, id, stored!);
      expect(await inUnit(() => reverter.revert(admin('structure-db-reviewer'), request))).toBe(
        'reverted',
      );
      expect(await attributeStatus(id)).toBe('archived');
    });

    it('files a discard for approval, and its approval discards the draft', async () => {
      const { attribute } = await newAttribute();
      const proposed = await new AttributeDefinitionDiscard(gate, deps).execute(
        admin('structure-db-attribute-discard'),
        { attributeId: attribute.id, version: attribute.version, note: 'Made by mistake' },
      );
      if (!proposed.ok || !isProposal(proposed.value)) {
        throw new Error('no proposal');
      }
      const proposal = proposed.value.request;
      expect(await attributeStatus(attribute.id)).toBe('draft');
      const stored = await inUnit(() => requests.find(market, proposal.id));
      expect(stored).toMatchObject({ mode: 'approval', subjectKind: 'catalog.attribute-discard' });
      const applier = new AttributeActionApplier(deps, ['discard']);
      const request = requestRef(proposal, attribute.id, stored!);
      const approver = admin('structure-db-approver');
      expect(await applier.check(approver, request)).toBe('ok');
      expect(await inUnit(() => applier.apply(approver, request))).toBe('applied');
      expect(await attributeStatus(attribute.id)).toBe('archived');
      expect(audits.at(-1)).toMatchObject({
        action: 'catalog.attribute-definition.discarded',
        after: { requestId: proposal.id },
      });
    });

    it('files an archive for approval, and its approval archives the published attribute', async () => {
      const { attribute } = await newAttribute();
      const published = await new AttributeDefinitionPublish(gate, deps).execute(
        admin('structure-db-publish'),
        { attributeId: attribute.id, version: attribute.version },
      );
      if (!published.ok) throw new Error(published.error.code);
      const proposed = await new AttributeArchive(gate, deps).execute(
        admin('structure-db-attribute-archive'),
        { attributeId: attribute.id, version: published.value.attribute.version, note: 'Unused' },
      );
      if (!proposed.ok || !isProposal(proposed.value)) {
        throw new Error('no proposal');
      }
      const proposal = proposed.value.request;
      expect(await attributeStatus(attribute.id)).toBe('active');
      const stored = await inUnit(() => requests.find(market, proposal.id));
      expect(stored).toMatchObject({
        mode: 'approval',
        subjectKind: 'catalog.attribute-restructure',
        after: { action: 'archive' },
      });
      const applier = new AttributeActionApplier(deps, ['archive', 'merge', 'merge-values']);
      const request = requestRef(proposal, attribute.id, stored!);
      expect(await inUnit(() => applier.apply(admin('structure-db-approver'), request))).toBe(
        'applied',
      );
      expect(await attributeStatus(attribute.id)).toBe('archived');
    });

    /** A new published select attribute with the given option codes. */
    async function publishedAttribute(options: readonly string[]) {
      const created = await create().execute(admin('structure-db-attribute'), {
        dataType: 'select',
        names: { [english]: `Size ${slugOf()}` },
        options: options.map((option) => ({ code: option, labels: { [english]: option } })),
        note: 'For the sizes',
      });
      if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
      const published = await new AttributeDefinitionPublish(gate, deps).execute(
        admin('structure-db-publish'),
        { attributeId: created.value.attribute.id, version: created.value.attribute.version },
      );
      if (!published.ok) throw new Error(published.error.code);
      return published.value.attribute;
    }

    it('files a merge for approval, and its approval merges it into the other attribute', async () => {
      const source = await publishedAttribute(['g500', 'kg1']);
      const target = await publishedAttribute(['g500', 'kg1']);
      const proposed = await new AttributeMerge(gate, deps).execute(
        admin('structure-db-attribute-merge'),
        {
          attributeId: source.id,
          version: source.version,
          target: target.id,
          targetVersion: target.version,
          options: { g500: 'g500', kg1: 'kg1' },
          note: 'Two names for one thing',
        },
      );
      if (!proposed.ok || !isProposal(proposed.value)) {
        throw new Error(`no proposal: ${proposed.ok ? 'applied' : proposed.error.code}`);
      }
      const proposal = proposed.value.request;
      expect(await attributeStatus(source.id)).toBe('active');
      const stored = await inUnit(() => requests.find(market, proposal.id));
      expect(stored).toMatchObject({
        status: 'open',
        mode: 'approval',
        subjectKind: 'catalog.attribute-restructure',
        subjectRef: source.id,
        after: { action: 'merge', targetId: target.id },
      });
      const applier = new AttributeActionApplier(deps, ['archive', 'merge', 'merge-values']);
      const request = requestRef(proposal, source.id, stored!);
      const approver = admin('structure-db-approver');
      expect(await applier.check(approver, request)).toBe('ok');
      expect(await inUnit(() => applier.apply(approver, request))).toBe('applied');
      expect(await attributeStatus(source.id)).toBe('archived');
      expect(audits.at(-1)).toMatchObject({ after: { requestId: proposal.id } });
      expect(await inUnit(() => applier.apply(approver, request))).toBe('changed-since');
    });

    it('files a merge of values for approval, and its approval merges the value', async () => {
      const attribute = await publishedAttribute(['g500', 'kg1']);
      const proposed = await new AttributeValuesMerge(gate, deps).execute(
        admin('structure-db-values-merge'),
        {
          attributeId: attribute.id,
          version: attribute.version,
          source: 'g500',
          target: 'kg1',
          note: 'Half a kilo is sold as one kilo now',
        },
      );
      if (!proposed.ok || !isProposal(proposed.value)) {
        throw new Error(`no proposal: ${proposed.ok ? 'applied' : proposed.error.code}`);
      }
      const proposal = proposed.value.request;
      const optionOf = async () =>
        (
          await sql.query<{ active: boolean; merged_into: string | null }>(
            `SELECT o.active, o.merged_into
               FROM catalog.attribute_definition_revision_options o
               JOIN catalog.attribute_definitions d
                 ON d.market_id = o.market_id AND d.published_revision_id = o.revision_id
              WHERE d.id = $1 AND o.option_code = 'g500'`,
            [attribute.id],
          )
        ).rows[0]!;
      expect(await optionOf()).toEqual({ active: true, merged_into: null });
      const stored = await inUnit(() => requests.find(market, proposal.id));
      expect(stored).toMatchObject({
        mode: 'approval',
        subjectKind: 'catalog.attribute-restructure',
        after: { action: 'merge-values', source: 'g500', target: 'kg1' },
      });
      const applier = new AttributeActionApplier(deps, ['archive', 'merge', 'merge-values']);
      const request = requestRef(proposal, attribute.id, stored!);
      const approver = admin('structure-db-approver');
      expect(await applier.check(approver, request)).toBe('ok');
      expect(await inUnit(() => applier.apply(approver, request))).toBe('applied');
      expect(await optionOf()).toEqual({ active: false, merged_into: 'kg1' });
      expect(audits.at(-1)).toMatchObject({ after: { requestId: proposal.id } });
    });

    /** The Core attributes a feature set needs, active in the Market (another spec may make them). */
    async function coreAttributes(): Promise<void> {
      for (const code of ['brand', 'country-of-origin']) {
        const found = await sql.query<{ status: string }>(
          'SELECT status FROM catalog.attribute_definitions WHERE market_id = $1 AND code = $2',
          [market.marketId, code],
        );
        if (found.rows[0]?.status === 'active') continue;
        if (found.rows.length > 0) throw new Error(`${code} is ${found.rows[0]!.status}`);
        const created = await create().execute(admin('structure-db-core'), {
          code,
          dataType: 'text',
          names: { [english]: code },
          note: 'A Core attribute',
        });
        if (!created.ok) {
          if (created.error.code === 'attribute.code-taken') continue;
          throw new Error(`create failed: ${created.error.code}`);
        }
        const published = await new AttributeDefinitionPublish(gate, deps).execute(
          admin('structure-db-publish'),
          { attributeId: created.value.attribute.id, version: created.value.attribute.version },
        );
        if (!published.ok) throw new Error(published.error.code);
      }
    }

    it('files a feature-set create for approval, and its approval creates the set', async () => {
      await coreAttributes();
      const name = `Pantry ${slugOf()}`;
      const body = {
        names: { [english]: name },
        groups: [
          {
            groupCode: 'core',
            names: { [english]: 'Core' },
            attributes: [
              { code: 'brand', level: 'required' },
              { code: 'country-of-origin', level: 'recommended' },
            ],
          },
        ],
      };
      const proposed = await new FeatureSetCreate(gate, deps).execute(
        admin('structure-db-feature-set'),
        { ...body, note: 'The pantry needs its own set' },
      );
      if (!proposed.ok || !isProposal(proposed.value)) {
        throw new Error(`no proposal: ${proposed.ok ? 'created' : proposed.error.code}`);
      }
      const proposal = proposed.value.request;
      const stored = await inUnit(() => requests.find(market, proposal.id));
      expect(stored).toMatchObject({
        status: 'open',
        mode: 'approval',
        subjectKind: 'catalog.feature-set-create',
        after: { action: 'create' },
      });
      const code = stored!.subjectRef;
      const setsOf = async () =>
        (
          await sql.query<{ status: string }>(
            'SELECT status FROM catalog.attribute_families WHERE market_id = $1 AND code = $2',
            [market.marketId, code],
          )
        ).rows;
      expect(await setsOf()).toEqual([]);
      const again = await new FeatureSetCreate(gate, deps).execute(
        admin('structure-db-feature-set-2'),
        { ...body, note: 'Again' },
      );
      expect(!again.ok && again.error).toMatchObject({ code: 'system-requests.already-pending' });

      const applier = new FeatureSetCreateApplier(deps);
      const request = requestRef(proposal, code, stored!);
      const approver = admin('structure-db-approver');
      expect(await applier.check(approver, request)).toBe('ok');
      expect(await inUnit(() => applier.apply(approver, request))).toBe('applied');
      expect(await setsOf()).toEqual([{ status: 'active' }]);
      expect(audits.at(-1)).toMatchObject({ after: { requestId: proposal.id } });
      // Its check result was taken once: a second apply fails closed and creates nothing more.
      expect(await inUnit(() => applier.apply(approver, request))).toBe('not-permitted');
      expect(await setsOf()).toHaveLength(1);
    });
  });
});
