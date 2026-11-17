import { randomUUID } from 'node:crypto';
import { devNull } from 'node:os';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pino from 'pino';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { AppModule } from '../../src/app.module';
import { CertificationModule } from '../../src/modules/certification';
import {
  CATALOG_REFERENCES,
  type CatalogReferences,
} from '../../src/modules/certification/application/ports/catalog-references';
import type { ClaimPolicyDependencies } from '../../src/modules/certification/application/registry/claim-policy.shared';
import {
  ClaimPolicyReverter,
  TypeRevisionReverter,
} from '../../src/modules/certification/application/registry/registry-reverters';
import type { RegistryDependencies } from '../../src/modules/certification/application/registry/registry.shared';
import { ClaimPolicySaveRevision } from '../../src/modules/certification/application/use-cases/claim-policy-save-revision.use-case';
import { TypeSaveRevision } from '../../src/modules/certification/application/use-cases/type-save-revision.use-case';
import type { TypeRevisionContent } from '../../src/modules/certification/domain/type-revision';
import { PrismaClaimPolicyRepository } from '../../src/modules/certification/infrastructure/prisma-claim-policy.repository';
import { REGISTRY_DEPENDENCIES } from '../../src/modules/certification/infrastructure/registry-providers';
import { SystemRequestsModule } from '../../src/modules/system-requests';
import {
  REQUEST_REPOSITORY,
  type RequestRepository,
} from '../../src/modules/system-requests/application/ports/request.repository';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { ID_GENERATOR } from '../../src/platform/ids/ids.module';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaService } from '../../src/platform/persistence/prisma.service';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import {
  testAppConfig,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../support/test-config';
import { marketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Area certification of Admin Inbox › System requests on the real recorder, the real certification
// stores, audit writer and outbox, in both Market fixtures (certification is reviewed by default,
// medium risk): a published save without a note leaves nothing behind (revision, pointer, event,
// audit row, request), one with a note opens its request in the same unit; the type reverter
// restores a neutral edit as a new published revision with the save's event and a `.reverted`
// audit row naming the request, then answers changed-since; a revert that would loosen
// enforcement (a type setting, a claim policy row) answers not-permitted and writes nothing.
// Types and categories are new per test, so nothing here meets another spec's rows.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-16T00:00:00Z');

describe.each(TEST_MARKETS)('certification reviews in market %s (database)', (code) => {
  const market = marketOf(code);
  const locales = markets.get(market.marketId).supportedLocales;
  // The edit keys are checked by the unit specs; here the stores, the recorder and the writers are real.
  const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
  const gate = createUseCaseGate(markets, admitAll);

  let app: INestApplicationContext;
  let deps: RegistryDependencies;
  let policyDeps: ClaimPolicyDependencies;
  let requests: RequestRepository;
  let sql: Client;
  let next: () => string;

  const admin = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: next() as Id<'Account'>,
        sessionId: next() as Id<'Session'>,
        sellerId: null,
      }),
      'certification-review-db',
    );

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
    const certification = app.select(CertificationModule);
    deps = certification.get<RegistryDependencies>(REGISTRY_DEPENDENCIES, { strict: true });
    const ids = deps.ids;
    next = () => ids.next<'Test'>();
    policyDeps = {
      ...deps,
      policies: new PrismaClaimPolicyRepository(app.get(PrismaService), app.get(ID_GENERATOR)),
      catalog: app.get<CatalogReferences>(CATALOG_REFERENCES),
    };
    requests = app
      .select(SystemRequestsModule)
      .get<RequestRepository>(REQUEST_REPOSITORY, { strict: true });
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await sql.end();
    await app.close();
  });

  const inUnit = async <T>(work: () => Promise<T>): Promise<T> => {
    const result = await deps.unitOfWork.run(market, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  const contentOf = (
    overrides: Partial<TypeRevisionContent> = {},
    name = 'Qorvane',
  ): TypeRevisionContent => ({
    verificationMode: 'THIRD_PARTY_DOCUMENT',
    requiresIssuerRegistry: true,
    requiresDocument: true,
    requiresExpiry: false,
    defaultBasis: 'SELLER_REQUIRED',
    autoApproveSelfDeclaration: false,
    badgeIconKey: 'seal',
    locales: Object.fromEntries(
      locales.map((l) => [
        l,
        { name, customerDescription: 'Holds a certificate.', claimTerms: ['qorvane'] },
      ]),
    ),
    ...overrides,
  });

  /** A type with its first revision published, created as the seed does. */
  async function type() {
    const typeId = next() as Id<'CertificationType'>;
    const revisionId = next() as Id<'CertificationTypeRevision'>;
    await sql.query(
      `INSERT INTO certification.certification_types
         (id, market_id, tenant_id, code, verification_mode, status, published_revision_id, version, created_at)
       VALUES ($1, $2, $3, $4, 'THIRD_PARTY_DOCUMENT', 'active', NULL, 1, $5)`,
      [typeId, market.marketId, market.tenantId, `r${typeId.slice(-12)}`, T0.toString()],
    );
    await inUnit(() =>
      deps.registry.addRevision(market, {
        id: revisionId,
        typeId,
        content: contentOf(),
        authorAccountId: next() as Id<'Account'>,
        changeReasonCiphertext: null,
        createdAt: T0,
      }),
    );
    await sql.query(
      'UPDATE certification.certification_types SET published_revision_id = $1 WHERE id = $2',
      [revisionId, typeId],
    );
    return { typeId, revisionId };
  }

  async function category(): Promise<Id<'Category'>> {
    const id = next() as Id<'Category'>;
    await sql.query(
      `INSERT INTO catalog.platform_categories
         (id, market_id, tenant_id, parent_id, slug, status, created_by_kind, version, created_at)
       VALUES ($1, $2, $3, NULL, $4, 'active', 'seed', 1, $5)`,
      [id, market.marketId, market.tenantId, `cr-${randomUUID().slice(0, 12)}`, T0.toString()],
    );
    return id;
  }

  const typeRow = async (typeId: string) =>
    (
      await sql.query<{ published_revision_id: string; version: number }>(
        'SELECT published_revision_id, version FROM certification.certification_types WHERE id = $1',
        [typeId],
      )
    ).rows[0]!;
  const count = async (text: string, values: unknown[]) =>
    Number((await sql.query<{ n: string }>(text, values)).rows[0]!.n);
  const revisionsOf = (typeId: string) =>
    count(
      'SELECT count(*) AS n FROM certification.certification_type_revisions WHERE type_id = $1',
      [typeId],
    );
  const eventsOf = (aggregateId: string) =>
    count('SELECT count(*) AS n FROM certification.outbox WHERE aggregate_id = $1', [aggregateId]);
  const auditOf = async (targetId: string) =>
    (
      await sql.query<{ action: string; after: Record<string, unknown> }>(
        `SELECT action, after FROM platform.audit_log
          WHERE market_id = $1 AND target_id = $2 ORDER BY occurred_at, action`,
        [market.marketId, targetId],
      )
    ).rows;
  const requestsOf = (subjectRef: string) =>
    count(
      'SELECT count(*) AS n FROM system_requests.requests WHERE market_id = $1 AND subject_ref = $2',
      [market.marketId, subjectRef],
    );

  it('keeps nothing of a type save without a note, and reverts a neutral one with its request', async () => {
    const { typeId, revisionId } = await type();
    const save = new TypeSaveRevision(gate, deps);
    const author = admin();
    const refused = await save.execute(author, {
      typeId,
      version: 1,
      content: contentOf({}, 'Qorvane Seal'),
    });
    expect(!refused.ok && refused.error).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'note', code: 'required' }],
    });
    expect(await typeRow(typeId)).toEqual({ published_revision_id: revisionId, version: 1 });
    expect(await revisionsOf(typeId)).toBe(1);
    expect(await eventsOf(typeId)).toBe(0);
    expect(await auditOf(typeId)).toEqual([]);
    expect(await requestsOf(typeId)).toBe(0);

    const saved = await save.execute(author, {
      typeId,
      version: 1,
      content: contentOf({}, 'Qorvane Seal'),
      note: 'Brand name',
    });
    if (!saved.ok || saved.value.outcome !== 'published' || saved.value.request === null) {
      throw new Error('no request opened');
    }
    const requestId = saved.value.request.id;
    const opened = await inUnit(() => requests.find(market, requestId));
    expect(opened).toMatchObject({
      status: 'open',
      area: 'certification',
      risk: 'medium',
      subjectKind: 'certification.type-revision',
      subjectRef: typeId,
      before: { revisionId, revisionNo: 1 },
      after: { revisionId: saved.value.revisionId, revisionNo: 2 },
    });

    const reverter = new TypeRevisionReverter(deps, admitAll);
    const request = {
      requestId,
      subjectRef: typeId,
      before: opened!.before,
      after: opened!.after,
    };
    expect(await inUnit(() => reverter.revert(admin(), request))).toBe('reverted');
    const row = await typeRow(typeId);
    expect(row.version).toBe(3);
    expect([revisionId, saved.value.revisionId]).not.toContain(row.published_revision_id);
    const restored = await inUnit(() =>
      deps.registry.revision(market, row.published_revision_id as Id<'CertificationTypeRevision'>),
    );
    expect(restored).toMatchObject({ revisionNo: 3, content: contentOf() });
    expect(await eventsOf(typeId)).toBe(2);
    expect((await auditOf(typeId)).map((entry) => entry.action)).toEqual([
      'certification.type.revised',
      'certification.type.reverted',
    ]);
    expect((await auditOf(typeId)).at(-1)!.after).toMatchObject({
      revisionId: row.published_revision_id,
      restoredRevisionId: revisionId,
      requestId,
    });
    expect(await inUnit(() => reverter.revert(admin(), request))).toBe('changed-since');
  });

  it('locks a type under its version without changing it; a moved version is stale', async () => {
    const { typeId } = await type();
    await inUnit(() => deps.registry.lockType(market, typeId, 1));
    expect(await typeRow(typeId)).toMatchObject({ version: 1 });
    await expect(inUnit(() => deps.registry.lockType(market, typeId, 2))).rejects.toBeInstanceOf(
      StaleAggregateError,
    );
  });

  it('answers not-permitted for a type revert that loosens, and writes nothing', async () => {
    const { typeId } = await type();
    const saved = await new TypeSaveRevision(gate, deps).execute(admin(), {
      typeId,
      version: 1,
      content: contentOf({ requiresExpiry: true }),
      note: 'Expiry needed',
    });
    if (!saved.ok || saved.value.request === null) throw new Error('no request opened');
    const opened = (await inUnit(() => requests.find(market, saved.value.request!.id)))!;
    const before = await typeRow(typeId);
    const reverter = new TypeRevisionReverter(deps, admitAll);
    expect(
      await inUnit(() =>
        reverter.revert(admin(), {
          requestId: opened.id,
          subjectRef: typeId,
          before: opened.before,
          after: opened.after,
        }),
      ),
    ).toBe('not-permitted');
    expect(await typeRow(typeId)).toEqual(before);
    expect(await revisionsOf(typeId)).toBe(2);
    expect((await auditOf(typeId)).map((entry) => entry.action)).toEqual([
      'certification.type.revised',
    ]);
  });

  it('opens a claim policy request on the first save and refuses its loosening revert', async () => {
    const { typeId } = await type();
    const food = await category();
    const save = new ClaimPolicySaveRevision(gate, policyDeps);
    const rows = [{ selector: 'platform-category', categoryId: food, basis: 'NOT_APPLICABLE' }];
    const refused = await save.execute(admin(), { typeId, version: 0, rows });
    expect(!refused.ok && refused.error.code).toBe('validation.failed');
    expect(await inUnit(() => policyDeps.policies.policyOfType(market, typeId))).toBeNull();

    const saved = await save.execute(admin(), { typeId, version: 0, rows, note: 'No claims' });
    if (!saved.ok || saved.value.outcome !== 'published' || saved.value.request === null) {
      throw new Error('no request opened');
    }
    const opened = (await inUnit(() => requests.find(market, saved.value.request!.id)))!;
    expect(opened).toMatchObject({
      area: 'certification',
      subjectKind: 'certification.claim-policy',
      subjectRef: typeId,
      before: { revisionId: null, revisionNo: null },
      after: { revisionId: saved.value.revisionId, changed: [`row:${food}`] },
    });
    const policyId = saved.value.policyId;
    const reverter = new ClaimPolicyReverter(policyDeps, admitAll);
    expect(
      await inUnit(() =>
        reverter.revert(admin(), {
          requestId: opened.id,
          subjectRef: typeId,
          before: opened.before,
          after: opened.after,
        }),
      ),
    ).toBe('not-permitted');
    const policy = await inUnit(() => policyDeps.policies.policyOfType(market, typeId));
    expect(policy).toMatchObject({ publishedRevisionId: saved.value.revisionId, version: 2 });
    expect(await eventsOf(policyId)).toBe(1);
    expect((await auditOf(policyId)).map((entry) => entry.action)).toEqual([
      'certification.claim-policy.revised',
    ]);
  });
});
