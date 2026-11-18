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
  type CatalogueStructureDependencies,
} from '../../src/modules/catalog/application/catalogue-appliers';
import { isProposal } from '../../src/modules/catalog/application/catalogue-review';
import {
  AttributeCreateReverter,
  CategoryCreateReverter,
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
import { CategoryArchive } from '../../src/modules/catalog/application/use-cases/category-archive.use-case';
import { CategoryCreate } from '../../src/modules/catalog/application/use-cases/category-create.use-case';
import { CategoryDiscard } from '../../src/modules/catalog/application/use-cases/category-discard.use-case';
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
import { testDatabaseUrl } from './test-database';

// Structure changes of area catalogue (Admin Inbox › System requests, owner decision of 18 Nov
// 2026) on the real proposer, recorder and catalog stores, in both Market fixtures (catalogue is
// reviewed by default): a discard or an archive files a proposal (approval mode) and writes nothing
// in catalog; its applier then writes it in the decision's unit, as the approving admin, naming
// the request, and answers changed-since the second time. A create or reorder applies at once and
// opens a review; its reverter undoes it. Records are new per test (and the tree version is read
// again on a race), so nothing here meets another spec's rows.

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
  });
});
