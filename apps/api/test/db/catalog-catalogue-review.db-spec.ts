import { devNull } from 'node:os';
import type { INestApplicationContext, InjectionToken } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pino from 'pino';
import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { AuditEntry, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { AppModule } from '../../src/app.module';
import {
  AttributeDefinitionReverter,
  CategoryDetailsReverter,
  CategoryLinksReverter,
  type CatalogueRevertDependencies,
} from '../../src/modules/catalog/application/catalogue-reverters';
import { ATTRIBUTE_ADMIN_READER } from '../../src/modules/catalog/application/ports/attribute-admin.reader';
import { ATTRIBUTE_DEFINITION_STORE } from '../../src/modules/catalog/application/ports/attribute-definition.store';
import { ATTRIBUTE_RELAXATION_STORE } from '../../src/modules/catalog/application/ports/attribute-relaxation.store';
import { CATEGORY_ATTRIBUTE_LINK_STORE } from '../../src/modules/catalog/application/ports/category-attribute-link.store';
import { CATEGORY_EDIT_STORE } from '../../src/modules/catalog/application/ports/category-edit.store';
import { PLATFORM_CATEGORY_REPOSITORY } from '../../src/modules/catalog/application/ports/platform-category.repository';
import type { ClaimTermLocales } from '../../src/modules/catalog/application/ports/claim-term-locales';
import type { ClaimTextMatcher } from '../../src/modules/catalog/application/ports/claim-text-matcher';
import { AttributeImportRun } from '../../src/modules/catalog/application/use-cases/attribute-import-run.use-case';
import { NO_REVIEW } from '../../src/modules/catalog/application/catalogue-review';
import { AttributeDefinitionCreate } from '../../src/modules/catalog/application/use-cases/attribute-definition-create.use-case';
import { AttributeDefinitionEdit } from '../../src/modules/catalog/application/use-cases/attribute-definition-edit.use-case';
import { AttributeDefinitionPublish } from '../../src/modules/catalog/application/use-cases/attribute-definition-publish.use-case';
import { CategoryAttributeLinksSet } from '../../src/modules/catalog/application/use-cases/category-attribute-links-set.use-case';
import { CategoryEditDetails } from '../../src/modules/catalog/application/use-cases/category-edit-details.use-case';
import { CatalogModule } from '../../src/modules/catalog/catalog.module';
import { ConfigCatalogMarketPolicy } from '../../src/modules/catalog/infrastructure/config-catalog-market-policy';
import {
  SYSTEM_REQUEST_RECORDER,
  SystemRequestsModule,
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
import { testDatabaseUrl } from './test-database';

// Area catalogue of Admin Inbox › System requests on the real recorder and the real catalog
// stores, in both Market fixtures (catalogue is reviewed by default, risk medium): an edit without
// a note leaves nothing behind, an edit with one opens its request in the same unit, and the
// reverters write the values before back as one more revision, audited with the request, then
// answer changed-since. Records are new per test, so nothing here meets another spec's rows.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);

describe.each(TEST_MARKETS)('catalogue reviews in market %s (database)', (code) => {
  const market = marketOf(code);
  const locales = policy.locales(market);
  const english = locales.default;
  const clock = new FixedClock(Temporal.Instant.from('2026-11-15T10:00:00Z'));
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
  let reverterDeps: CatalogueRevertDependencies;
  let editDetails: CategoryEditDetails;
  let create: AttributeDefinitionCreate;
  let publish: AttributeDefinitionPublish;
  let editAttribute: AttributeDefinitionEdit;
  let setLinks: CategoryAttributeLinksSet;
  const audits: AuditEntry[] = [];

  const matcher: ClaimTextMatcher = {
    match: (_context, texts) => Promise.resolve(ok(texts.map(() => []))),
  };
  const claimLocales: ClaimTermLocales = {
    covered: () => Promise.resolve(ok([...locales.supported, code === 'AU' ? 'en-AU' : 'en-US'])),
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
    const audit: AuditWriter = {
      record: (context, entry) => {
        audits.push(entry);
        return realAudit.record(context, entry);
      },
    };
    const review = reviews.get<SystemRequestRecorder>(SYSTEM_REQUEST_RECORDER, { strict: true });
    unitOfWork = app.get<UnitOfWork>(UNIT_OF_WORK);
    requests = reviews.get<RequestRepository>(REQUEST_REPOSITORY, { strict: true });
    const store = port<CatalogueRevertDependencies['store']>(CATEGORY_EDIT_STORE);
    const categories = port<CatalogueRevertDependencies['categories']>(
      PLATFORM_CATEGORY_REPOSITORY,
    );
    const linkStore = port<CatalogueRevertDependencies['linkStore']>(CATEGORY_ATTRIBUTE_LINK_STORE);
    const attributeAdminReader =
      port<CatalogueRevertDependencies['attributeAdminReader']>(ATTRIBUTE_ADMIN_READER);
    const attributeStore = port<CatalogueRevertDependencies['attributeStore']>(
      ATTRIBUTE_DEFINITION_STORE,
    );
    const relaxations = port<CatalogueRevertDependencies['relaxations']>(
      ATTRIBUTE_RELAXATION_STORE,
    );
    const outbox = port<CatalogueRevertDependencies['outbox']>(OUTBOX_WRITER);
    reverterDeps = {
      store,
      categories,
      linkStore,
      attributeAdminReader,
      attributeStore,
      relaxations,
      audit,
      outbox,
      clock,
      ids,
    };
    editDetails = new CategoryEditDetails(gate, {
      contentFilter: new ContentFilter(markets),
      unitOfWork,
      store,
      categories,
      policy,
      matcher,
      claimLocales,
      audit,
      outbox,
      clock,
      ids,
      review,
    });
    const attributeDeps = {
      unitOfWork,
      attributeStore,
      relaxations,
      policy,
      matcher,
      claimLocales,
      audit,
      clock,
      ids,
      review,
    };
    create = new AttributeDefinitionCreate(gate, attributeDeps);
    publish = new AttributeDefinitionPublish(gate, attributeDeps);
    editAttribute = new AttributeDefinitionEdit(gate, attributeDeps);
    setLinks = new CategoryAttributeLinksSet(gate, {
      unitOfWork,
      linkStore,
      attributeAdminReader,
      audit,
      clock,
      ids,
      review,
    });
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await sql.end();
    await app.close();
  });

  const inUnit = async <T>(work: () => Promise<T>): Promise<T> => {
    const result = await unitOfWork.run(market, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const slugOf = (): string =>
    `cr-${uuidV7(Date.now(), crypto.getRandomValues(new Uint8Array(10))).slice(-12)}`;

  /** A new active category with one name; its id and version. */
  async function activeCategory(name: string): Promise<{ id: Id<'Category'>; version: number }> {
    const id = ids.next<'Category'>();
    await inUnit(async () => {
      await reverterDeps.store.insert(market, {
        id,
        revisionId: ids.next<'CategoryRevision'>(),
        parentId: null,
        slug: slugOf(),
        texts: [{ locale: english, name, shortDescription: null, keywords: [] }],
        seo: { title: null, description: null, noindex: false },
        showInMenu: true,
        authorAccountId: ids.next<'Account'>(),
        now: clock.now(),
      });
    });
    const [node] = (await inUnit(() => reverterDeps.store.loadAll(market, 100_000))).filter(
      (entry) => entry.id === id,
    );
    await inUnit(() =>
      reverterDeps.store.apply(market, {
        category: node!,
        revisionId: ids.next<'CategoryRevision'>(),
        kind: 'shown',
        texts: node!.texts,
        patch: { status: 'active' },
        authorAccountId: ids.next<'Account'>(),
        now: clock.now(),
      }),
    );
    return { id, version: node!.version + 1 };
  }
  const categoryRow = async (id: string) =>
    (
      await sql.query<{ version: number; show_in_menu: boolean }>(
        `SELECT version, show_in_menu FROM catalog.platform_categories WHERE id = $1`,
        [id],
      )
    ).rows[0]!;
  const categoryName = async (id: string) =>
    (
      await sql.query<{ name: string }>(
        `SELECT n.name FROM catalog.platform_category_revision_names n
           JOIN catalog.platform_categories c ON c.published_revision_id = n.revision_id
          WHERE c.id = $1 AND n.locale = $2`,
        [id, english],
      )
    ).rows[0]?.name;

  it('keeps nothing of a category edit without a note, and reverts one with its request', async () => {
    const { id, version } = await activeCategory('Pantry');
    const author = admin('catalogue-db-author');
    const texts = { [english]: { name: 'Pantry goods', keywords: ['dry'] } };

    const refused = await editDetails.execute(author, {
      categoryId: id,
      version,
      texts,
      showInMenu: false,
    });
    expect(!refused.ok && refused.error).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'note', code: 'required' }],
    });
    expect(await categoryName(id)).toBe('Pantry');
    expect(await categoryRow(id)).toMatchObject({ show_in_menu: true });

    const saved = await editDetails.execute(author, {
      categoryId: id,
      version,
      texts,
      showInMenu: false,
      note: 'Aisle signs changed',
    });
    if (!saved.ok || saved.value.request === null) throw new Error('no request opened');
    expect(await categoryName(id)).toBe('Pantry goods');
    const requestId = saved.value.request.id;
    const before = {
      names: { [english]: 'Pantry' },
      shortDescriptions: { [english]: null },
      keywords: { [english]: [] },
      seoTitle: null,
      seoDescription: null,
      noindex: false,
      showInMenu: true,
    };
    const after = {
      ...before,
      names: { [english]: 'Pantry goods' },
      keywords: { [english]: ['dry'] },
      showInMenu: false,
    };
    expect(await inUnit(() => requests.find(market, requestId))).toMatchObject({
      status: 'open',
      area: 'catalogue',
      risk: 'medium',
      subjectKind: 'catalog.category-details',
      subjectRef: id,
      before,
      after,
    });

    const reverter = new CategoryDetailsReverter(reverterDeps);
    const request = { requestId, subjectRef: id, before, after };
    const reviewer = admin('catalogue-db-reviewer');
    expect(await inUnit(() => reverter.revert(reviewer, request))).toBe('reverted');
    expect(await categoryName(id)).toBe('Pantry');
    expect(await categoryRow(id)).toMatchObject({ show_in_menu: true });
    expect(audits.at(-1)).toMatchObject({
      action: 'catalog.platform-category.details-reverted',
      targetId: id,
      after: { requestId },
    });
    expect(await inUnit(() => reverter.revert(reviewer, request))).toBe('changed-since');
  });

  it('runs the attribute file import through the editor with no review (import is not reviewed)', () => {
    const run = app.select(CatalogModule).get(AttributeImportRun, { strict: true });
    const edit = (run as unknown as { deps: { attributeEdit: { deps: { review: unknown } } } }).deps
      .attributeEdit;
    expect(edit.deps.review).toBe(NO_REVIEW);
    const panel = app.select(CatalogModule).get(AttributeDefinitionEdit, { strict: true });
    expect((panel as unknown as { deps: { review: unknown } }).deps.review).not.toBe(NO_REVIEW);
  });

  it('answers gone for a category that is not there', async () => {
    const { id } = await activeCategory('Spices');
    const reverter = new CategoryDetailsReverter(reverterDeps);
    const values = {
      names: { [english]: 'Spices' },
      shortDescriptions: { [english]: null },
      keywords: { [english]: [] },
      seoTitle: null,
      seoDescription: null,
      noindex: false,
      showInMenu: true,
    };
    const missing = ids.next<'Category'>();
    expect(
      await inUnit(() =>
        reverter.revert(admin('catalogue-db-gone'), {
          requestId: ids.next<'SystemRequest'>(),
          subjectRef: missing,
          before: values,
          after: { ...values, showInMenu: false },
        }),
      ),
    ).toBe('gone');
    expect(await categoryName(id)).toBe('Spices');
  });

  it('keeps nothing of an attribute edit without a note, and reverts one, keeping an added value off', async () => {
    const author = admin('catalogue-db-attribute');
    const draft = await create.execute(author, {
      dataType: 'select',
      names: { [english]: `Pack size ${slugOf()}` },
      options: [{ code: 'g500', labels: { [english]: '500 g' } }],
    });
    if (!draft.ok) throw new Error(`create failed: ${draft.error.code}`);
    const attributeId = draft.value.attribute.id as Id<'AttributeDefinition'>;
    const published = await publish.execute(author, { attributeId, version: 1 });
    expect(published.ok).toBe(true);

    const content = {
      names: { [english]: `Pack size ${slugOf()}` },
      options: [
        { code: 'g500', labels: { [english]: '500 g' } },
        { code: 'kg1', labels: { [english]: '1 kg' } },
      ],
      searchable: true,
    };
    const refused = await editAttribute.execute(author, { attributeId, version: 2, ...content });
    expect(!refused.ok && refused.error).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'note', code: 'required' }],
    });
    const revisionCount = async () =>
      Number(
        (
          await sql.query<{ count: string }>(
            'SELECT count(*) FROM catalog.attribute_definition_revisions WHERE definition_id = $1',
            [attributeId],
          )
        ).rows[0]!.count,
      );
    // Publishing moves the status, not the content: still the first revision.
    expect(await revisionCount()).toBe(1);

    const saved = await editAttribute.execute(author, {
      attributeId,
      version: 2,
      ...content,
      note: 'Added the 1 kg pack',
    });
    if (!saved.ok || saved.value.request === null) throw new Error('no request opened');
    expect(await revisionCount()).toBe(2);
    const requestId = saved.value.request.id;
    const stored = await inUnit(() => requests.find(market, requestId));
    expect(stored).toMatchObject({
      status: 'open',
      area: 'catalogue',
      subjectKind: 'catalog.attribute-definition',
      subjectRef: attributeId,
      before: { revisionNo: 1, version: 2, optionCount: 1, searchable: false },
      after: { revisionNo: 2, version: 3, optionCount: 2, searchable: true },
    });

    const reverter = new AttributeDefinitionReverter(reverterDeps);
    const request = {
      requestId,
      subjectRef: attributeId,
      before: stored!.before,
      after: stored!.after,
    };
    const reviewer = admin('catalogue-db-reviewer');
    expect(await inUnit(() => reverter.revert(reviewer, request))).toBe('reverted');
    expect(await revisionCount()).toBe(3);
    const options = await sql.query<{ code: string; is_active: boolean }>(
      `SELECT o.option_code AS code, o.active AS is_active
         FROM catalog.attribute_definition_revision_options o
         JOIN catalog.attribute_definitions d ON d.published_revision_id = o.revision_id
        WHERE d.id = $1 ORDER BY o.position`,
      [attributeId],
    );
    // The value the edit added is never removed: it stays, switched off.
    expect(options.rows).toEqual([
      { code: 'g500', is_active: true },
      { code: 'kg1', is_active: false },
    ]);
    expect(audits.at(-1)).toMatchObject({
      action: 'catalog.attribute-definition.reverted',
      targetId: attributeId,
      after: { requestId },
    });
    expect(await inUnit(() => reverter.revert(reviewer, request))).toBe('changed-since');
    expect(await revisionCount()).toBe(3);
  });

  it('keeps nothing of a filter change without a note, and reverts one with its request', async () => {
    const author = admin('catalogue-db-links');
    const { id: categoryId } = await activeCategory('Rice');
    const draft = await create.execute(author, {
      dataType: 'select',
      names: { [english]: `Origin ${slugOf()}` },
      options: [{ code: 'pk', labels: { [english]: 'Pakistan' } }],
      canBeFilter: true,
    });
    if (!draft.ok) throw new Error(`create failed: ${draft.error.code}`);
    const attributeId = draft.value.attribute.id as Id<'AttributeDefinition'>;
    const attributeCode = draft.value.attribute.code;
    expect((await publish.execute(author, { attributeId, version: 1 })).ok).toBe(true);

    const linkRevisions = async () =>
      Number(
        (
          await sql.query<{ count: string }>(
            'SELECT count(*) FROM catalog.category_attribute_link_revisions WHERE category_id = $1',
            [categoryId],
          )
        ).rows[0]!.count,
      );
    const refused = await setLinks.execute(author, {
      categoryId,
      featureSetId: null,
      filters: [attributeCode],
    });
    expect(!refused.ok && refused.error).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'note', code: 'required' }],
    });
    expect(await linkRevisions()).toBe(0);

    const saved = await setLinks.execute(author, {
      categoryId,
      featureSetId: null,
      filters: [attributeCode],
      note: 'Rice is filtered by origin',
    });
    if (!saved.ok || saved.value.request === null) throw new Error('no request opened');
    expect(await linkRevisions()).toBe(1);
    const requestId = saved.value.request.id;
    const before = { featureSetId: null, filters: [] };
    const after = { featureSetId: null, filters: [attributeCode] };
    expect(await inUnit(() => requests.find(market, requestId))).toMatchObject({
      status: 'open',
      area: 'catalogue',
      subjectKind: 'catalog.category-attribute-links',
      subjectRef: categoryId,
      before,
      after,
    });

    const reverter = new CategoryLinksReverter(reverterDeps);
    const request = { requestId, subjectRef: categoryId, before, after };
    const reviewer = admin('catalogue-db-reviewer');
    expect(await inUnit(() => reverter.revert(reviewer, request))).toBe('reverted');
    expect(await linkRevisions()).toBe(2);
    expect(
      (await inUnit(() => reverterDeps.linkStore.find(market, categoryId)))?.state,
    ).toMatchObject({ familyId: null, filters: [], revisionNo: 2 });
    expect(audits.at(-1)).toMatchObject({
      action: 'catalog.category-attributes.reverted',
      targetId: categoryId,
      after: { requestId },
    });
    expect(await inUnit(() => reverter.revert(reviewer, request))).toBe('changed-since');
  });
});
