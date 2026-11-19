import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { AssertCategoriesRetirable } from '../../src/modules/certification/application/use-cases/assert-categories-retirable.use-case';
import { PlatformCategoriesRetired } from '../../src/modules/certification/application/use-cases/platform-categories-retired.use-case';
import { CERTIFICATION_AUDIT_ACTIONS } from '../../src/modules/certification/domain/audit';
import { PrismaCategoryRetirementRepository } from '../../src/modules/certification/infrastructure/prisma-category-retirement.repository';
import { AuditActionCatalogue } from '../../src/platform/audit/audit-action-catalogue';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { ids } from './outbox-support';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// `assertCategoriesRetirable` and the `platformCategoriesRetired` backstop on PostgreSQL (design
// 3.7, 8.1; data design A12; B2; C-4), for both Market fixtures, as the application login. A
// category blocks while a NOT_APPLICABLE or SELLER_REQUIRED row of a policy's PUBLISHED revision,
// or of the revision a PENDING relaxation would publish, names it; a SELLER_OR_MANUFACTURER row,
// an older revision, a withdrawn proposal's revision, a handling row and another Market's row
// never block. The backstop flags each named id once with one system audit row (the relaxing one
// also a security event), ignores unnamed ids and writes nothing on a repeat.
//
// The run database is shared with specs running in parallel, so every category id here is new
// and every assertion looks only at the ids seeded here.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = '2026-10-21T00:00:00Z';
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

interface Row {
  readonly category?: string;
  readonly handling?: string;
  readonly basis: string;
}

describe.each(TEST_MARKETS)('category retirement check in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let persistence: Persistence;
  let repository: PrismaCategoryRetirementRepository;
  let sql: Client;
  let owner: Client;
  let audit: AuditWriter;

  beforeAll(async () => {
    persistence = createPersistence();
    repository = new PrismaCategoryRetirementRepository(
      persistence.unitOfWork,
      persistence.service,
    );
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
    const auditCatalogue = new AuditActionCatalogue();
    auditCatalogue.register('certification', CERTIFICATION_AUDIT_ACTIONS);
    auditCatalogue.seal();
    audit = PersistenceModule.auditWriterFor('certification').useFactory(
      auditCatalogue,
      ids,
      { now: () => Temporal.Now.instant() },
      NO_PERMISSION_KEYS,
    ) as AuditWriter;
  });
  afterAll(async () => {
    await sql.end();
    await owner.end();
    await persistence.close();
  });

  const scope = (target: MarketContext) => [target.marketId, target.tenantId];

  async function seedType(target: MarketContext): Promise<{ id: string; code: string }> {
    const typeId = uuid7();
    const typeCode = `t${typeId.slice(-12)}`;
    await owner.query(
      `INSERT INTO certification.certification_types
         (id, market_id, tenant_id, code, verification_mode, status, published_revision_id, version, created_at)
       VALUES ($1, $2, $3, $4, 'THIRD_PARTY_DOCUMENT', 'active', NULL, 1, $5)`,
      [typeId, ...scope(target), typeCode, T0],
    );
    return { id: typeId, code: typeCode };
  }

  /**
   * A policy of the type with one revision per row set: `published` is the index of the live one,
   * `proposed` the index of a revision a relaxation proposal in `proposalState` would publish.
   */
  async function seedPolicy(
    target: MarketContext,
    typeId: string,
    revisions: readonly (readonly Row[])[],
    published: number | null,
    proposed?: { readonly index: number; readonly state: 'pending' | 'withdrawn' },
  ): Promise<void> {
    const policyId = uuid7();
    await owner.query(
      `INSERT INTO certification.claim_basis_policies
         (id, market_id, tenant_id, type_id, published_revision_id, version, created_at)
       VALUES ($1, $2, $3, $4, NULL, 1, $5)`,
      [policyId, ...scope(target), typeId, T0],
    );
    const revisionIds: string[] = [];
    for (const [index, rows] of revisions.entries()) {
      const revisionId = uuid7();
      revisionIds.push(revisionId);
      await owner.query(
        `INSERT INTO certification.claim_policy_revisions
           (id, market_id, tenant_id, policy_id, revision_no, author_account_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [revisionId, ...scope(target), policyId, index + 1, uuid7(), T0],
      );
      for (const row of rows) {
        await owner.query(
          `INSERT INTO certification.claim_policy_rows
             (id, market_id, tenant_id, revision_id, selector_kind, category_id, handling, basis)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            uuid7(),
            ...scope(target),
            revisionId,
            row.category === undefined ? 'handling' : 'platform-category',
            row.category ?? null,
            row.handling ?? null,
            row.basis,
          ],
        );
      }
    }
    if (published !== null) {
      await owner.query(
        `UPDATE certification.claim_basis_policies SET published_revision_id = $1 WHERE id = $2`,
        [revisionIds[published], policyId],
      );
    }
    if (proposed !== undefined) {
      await owner.query(
        `INSERT INTO certification.relaxation_proposals
           (id, market_id, tenant_id, subject_kind, subject_id, based_on_revision_id,
            proposed_revision_id, state, proposer_account_id, proposed_at, decided_at, version, created_at)
         VALUES ($1, $2, $3, 'claim-policy-revision', $4, $5, $6, $7, $8, $9, $10, 1, $9)`,
        [
          uuid7(),
          ...scope(target),
          policyId,
          published === null ? null : revisionIds[published],
          revisionIds[proposed.index],
          proposed.state,
          uuid7(),
          T0,
          proposed.state === 'pending' ? null : T0,
        ],
      );
    }
  }

  const categories = (n: number) => Array.from({ length: n }, () => uuid7() as Id<'Category'>);

  it('answers the codes of the types whose published or pending relaxing rows name the ids, sorted, once', async () => {
    const [na, sr, som, old, pend, wdn, handlingOnly, foreign] = categories(8);
    const first = await seedType(market);
    const second = await seedType(market);
    const third = await seedType(market);
    const fourth = await seedType(market);
    const foreignType = await seedType(other);
    // Published: NOT_APPLICABLE and SELLER_REQUIRED block, SELLER_OR_MANUFACTURER does not; an
    // older revision's row does not.
    await seedPolicy(
      market,
      first.id,
      [
        [{ category: old!, basis: 'SELLER_REQUIRED' }],
        [
          { category: na!, basis: 'NOT_APPLICABLE' },
          { category: som!, basis: 'SELLER_OR_MANUFACTURER' },
          { handling: 'SEALED_ORIGINAL', basis: 'SELLER_REQUIRED' },
        ],
      ],
      1,
    );
    await seedPolicy(market, second.id, [[{ category: sr!, basis: 'SELLER_REQUIRED' }]], 0);
    // A pending relaxation's revision blocks; a withdrawn one's does not.
    await seedPolicy(market, third.id, [[], [{ category: pend!, basis: 'NOT_APPLICABLE' }]], 0, {
      index: 1,
      state: 'pending',
    });
    await seedPolicy(market, fourth.id, [[], [{ category: wdn!, basis: 'NOT_APPLICABLE' }]], 0, {
      index: 1,
      state: 'withdrawn',
    });
    await seedPolicy(
      other,
      foreignType.id,
      [[{ category: foreign!, basis: 'SELLER_REQUIRED' }]],
      0,
    );

    const check = new AssertCategoriesRetirable(gate, repository);
    const ask = (target: MarketContext, list: readonly string[]) =>
      check.execute(testCallContext(target, 'anonymous'), { categoryIds: list });

    expect(await ask(market, [na!, sr!, som!])).toEqual({
      ok: false,
      error: {
        code: 'category.referenced-by-policy',
        typeCodes: [first.code, second.code].sort(),
      },
    });
    expect(await ask(market, [pend!])).toEqual({
      ok: false,
      error: { code: 'category.referenced-by-policy', typeCodes: [third.code] },
    });
    for (const free of [som!, old!, wdn!, handlingOnly!, foreign!]) {
      expect(await ask(market, [free])).toEqual({ ok: true, value: undefined });
    }
    expect(await ask(other, [foreign!])).toEqual({
      ok: false,
      error: { code: 'category.referenced-by-policy', typeCodes: [foreignType.code] },
    });
    expect(await ask(other, [na!, sr!, pend!])).toEqual({ ok: true, value: undefined });
  });

  it('flags each named id once with one system audit row, the relaxing one a security event; a repeat writes nothing', async () => {
    const [relaxing, stricter, unnamed] = categories(3);
    const type = await seedType(market);
    await seedPolicy(
      market,
      type.id,
      [
        [
          { category: relaxing!, basis: 'SELLER_REQUIRED' },
          { category: stricter!, basis: 'SELLER_OR_MANUFACTURER' },
        ],
      ],
      0,
    );
    const backstop = new PlatformCategoriesRetired(gate, {
      unitOfWork: persistence.unitOfWork,
      repository,
      audit,
      clock: new FixedClock(Temporal.Instant.from('2026-11-05T10:00:00Z')),
    });
    const run = () =>
      backstop.execute(testCallContext(market, 'system', `db-${uuid7()}`), {
        categoryIds: [relaxing!, stricter!, unnamed!, relaxing!],
      });

    expect(await run()).toEqual({ ok: true, value: { flagged: 2, relaxing: 1 } });
    expect(await run()).toEqual({ ok: true, value: { flagged: 0, relaxing: 0 } });

    const flags = await sql.query<{ category_id: string; cleared_at: Date | null }>(
      `SELECT category_id, cleared_at FROM certification.retired_category_flags
        WHERE market_id = $1 AND category_id = ANY($2::uuid[]) ORDER BY category_id`,
      [market.marketId, [relaxing, stricter, unnamed]],
    );
    expect(flags.rows).toEqual(
      [relaxing!, stricter!].sort().map((id) => ({ category_id: id, cleared_at: null })),
    );
    const audits = await sql.query<{ action: string; target_id: string; actor_type: string }>(
      `SELECT action, target_id, actor_type FROM platform.audit_log
        WHERE market_id = $1 AND target_id = ANY($2) ORDER BY action`,
      [market.marketId, [relaxing, stricter, unnamed]],
    );
    expect(audits.rows).toEqual([
      {
        action: 'certification.retired-category.flagged',
        target_id: stricter,
        actor_type: 'SYSTEM',
      },
      {
        action: 'certification.retired-category.flagged-relaxing',
        target_id: relaxing,
        actor_type: 'SYSTEM',
      },
    ]);
    const events = await sql.query<{ type: string; severity: string }>(
      `SELECT type, severity FROM platform.security_events
        WHERE market_id = $1 AND target_id = ANY($2)`,
      [market.marketId, [relaxing, stricter, unnamed]],
    );
    expect(events.rows).toEqual([
      { type: 'certification.retired-category.flagged-relaxing', severity: 's2' },
    ]);
    // Another Market's call flags nothing of this Market's.
    expect(
      await backstop.execute(testCallContext(other, 'system', `db-${uuid7()}`), {
        categoryIds: [relaxing!, stricter!],
      }),
    ).toEqual({ ok: true, value: { flagged: 0, relaxing: 0 } });
  });
});
