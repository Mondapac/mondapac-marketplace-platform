import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { CertificationTypes } from '../../src/modules/certification/application/use-cases/certification-types.use-case';
import { MatchClaimTerms } from '../../src/modules/certification/application/use-cases/match-claim-terms.use-case';
import {
  SEED_AUTHOR_ACCOUNT_ID,
  SeedCertificationTypes,
} from '../../src/modules/certification/application/use-cases/seed-certification-types.use-case';
import { PrismaCertificationTypeRepository } from '../../src/modules/certification/infrastructure/prisma-certification-type.repository';
import { PrismaPublishedTypesReader } from '../../src/modules/certification/infrastructure/prisma-published-types.reader';
import { UnitPublishedTypesReader } from '../../src/modules/certification/infrastructure/unit-published-types.reader';
import { CheckedInTypeSeed } from '../../src/modules/certification/infrastructure/seed/checked-in-type-seed';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { certSeedTestDatabaseUrl } from './test-database';

// The type seed (certification design 5.2) on PostgreSQL for both Market fixtures: the real
// repository inside the real unit of work, run twice, never rewriting a type an admin changed,
// then read back through the real published-types reader and the two facade queries.

const T0 = '2026-10-14T00:00:00Z';
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const seed = new CheckedInTypeSeed();

describe.each(TEST_MARKETS)('certification type seed in market %s (database)', (code) => {
  const market = marketOf(code);
  const expected = seed.types(market);
  let persistence: Persistence;
  let sql: Client;
  let useCase: SeedCertificationTypes;
  let matchClaimTerms: MatchClaimTerms;
  let certificationTypes: CertificationTypes;
  const system = () => testCallContext(market, 'system', `db-cert-seed-${code}-0001`);
  const anonymous = () => testCallContext(market, 'anonymous', `db-cert-read-${code}-0001`);

  beforeAll(async () => {
    persistence = createPersistence({
      pause: () => Promise.resolve(),
      databaseUrl: certSeedTestDatabaseUrl(),
    });
    sql = new Client({ connectionString: certSeedTestDatabaseUrl() });
    await sql.connect();
    const gate = createUseCaseGate(markets, null);
    useCase = new SeedCertificationTypes(gate, {
      unitOfWork: persistence.unitOfWork,
      types: new PrismaCertificationTypeRepository(persistence.service),
      seed,
      supportedLocales: (m) => markets.get(m.marketId).supportedLocales,
      clock: new FixedClock(Temporal.Instant.from(T0)),
      ids: {
        next: <T extends string>() =>
          uuidV7(Date.now(), crypto.getRandomValues(new Uint8Array(10))) as Id<T>,
      },
    });
    const reader = new UnitPublishedTypesReader(
      persistence.unitOfWork,
      new PrismaPublishedTypesReader(persistence.service),
    );
    matchClaimTerms = new MatchClaimTerms(gate, reader);
    certificationTypes = new CertificationTypes(gate, reader);
  });
  afterAll(async () => {
    await sql.end();
    await persistence.close();
  });

  const typeRows = async () =>
    (
      await sql.query(
        `SELECT id, code, status, published_revision_id, version
           FROM certification.certification_types WHERE market_id = $1 ORDER BY code`,
        [market.marketId],
      )
    ).rows as { id: string; code: string; status: string; published_revision_id: string | null }[];

  it('creates every type with a published revision, once, and nothing on a rerun', async () => {
    await expect(useCase.execute(system(), {})).resolves.toEqual({
      ok: true,
      value: { created: expected.length },
    });
    await expect(useCase.execute(system(), {})).resolves.toEqual({
      ok: true,
      value: { created: 0 },
    });
    const rows = await typeRows();
    expect(rows.map((r) => r.code)).toEqual(expected.map((t) => t.code).sort());
    expect(rows.every((r) => r.published_revision_id !== null)).toBe(true);
    const revisions = await sql.query(
      `SELECT count(*)::int AS n, bool_and(author_account_id = $2) AS seeded
         FROM certification.certification_type_revisions WHERE market_id = $1`,
      [market.marketId, SEED_AUTHOR_ACCOUNT_ID],
    );
    expect(revisions.rows[0]).toEqual({ n: expected.length, seeded: true });
  });

  it('never overwrites a type an admin changed', async () => {
    const [row] = await typeRows();
    // An admin saves revision 2 and moves the pointer (what the editor will do).
    const revisionId = uuidV7(Date.now(), crypto.getRandomValues(new Uint8Array(10)));
    const first = (
      await sql.query(`SELECT * FROM certification.certification_type_revisions WHERE id = $1`, [
        row!.published_revision_id,
      ])
    ).rows[0] as Record<string, unknown>;
    await sql.query('BEGIN');
    await sql.query(
      `INSERT INTO certification.certification_type_revisions
         (id, market_id, tenant_id, type_id, revision_no, verification_mode, requires_issuer_registry,
          requires_document, requires_expiry, default_basis, auto_approve_self_declaration,
          badge_icon_key, author_account_id, created_at)
       VALUES ($1,$2,$3,$4,2,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        revisionId,
        market.marketId,
        market.tenantId,
        row!.id,
        first.verification_mode,
        first.requires_issuer_registry,
        first.requires_document,
        first.requires_expiry,
        first.default_basis,
        first.auto_approve_self_declaration,
        first.badge_icon_key,
        uuidV7(Date.now(), crypto.getRandomValues(new Uint8Array(10))),
        T0,
      ],
    );
    const texts = (
      await sql.query(
        `SELECT locale, name, customer_description FROM certification.type_revision_texts WHERE type_revision_id = $1`,
        [row!.published_revision_id],
      )
    ).rows as { locale: string; name: string; customer_description: string }[];
    for (const t of texts) {
      await sql.query(
        `INSERT INTO certification.type_revision_texts (market_id, tenant_id, type_revision_id, locale, name, customer_description)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          market.marketId,
          market.tenantId,
          revisionId,
          t.locale,
          `${t.name} (edited)`,
          t.customer_description,
        ],
      );
      // The admin keeps the seeded terms and adds one.
      await sql.query(
        `INSERT INTO certification.claim_terms (market_id, tenant_id, type_revision_id, locale, phrase)
         SELECT market_id, tenant_id, $1, locale, phrase FROM certification.claim_terms
          WHERE type_revision_id = $2 AND locale = $3`,
        [revisionId, row!.published_revision_id, t.locale],
      );
      await sql.query(
        `INSERT INTO certification.claim_terms (market_id, tenant_id, type_revision_id, locale, phrase)
         VALUES ($1,$2,$3,$4,$5)`,
        [market.marketId, market.tenantId, revisionId, t.locale, 'adminterm'],
      );
    }
    await sql.query(
      `UPDATE certification.certification_types SET published_revision_id = $1 WHERE id = $2`,
      [revisionId, row!.id],
    );
    await sql.query('COMMIT');

    await expect(useCase.execute(system(), {})).resolves.toEqual({
      ok: true,
      value: { created: 0 },
    });
    const after = (await typeRows()).find((r) => r.id === row!.id);
    expect(after!.published_revision_id).toBe(revisionId);
    const count = await sql.query(
      `SELECT count(*)::int AS n FROM certification.certification_type_revisions WHERE type_id = $1`,
      [row!.id],
    );
    expect((count.rows[0] as { n: number }).n).toBe(2);
  });

  it('answers certificationTypes with every seeded type, active and inactive', async () => {
    const result = await certificationTypes.execute(anonymous(), { filter: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((t) => t.code)).toEqual(expected.map((t) => t.code).sort());
    for (const type of expected) {
      expect(result.value.find((t) => t.code === type.code)!.status).toBe(type.status);
    }
  });

  it('answers matchClaimTerms from the seeded vocabulary, inactive types included', async () => {
    const probes =
      code === 'AU'
        ? [
            ['h-a-l-a-l', 'halal'],
            ['ha1al', 'halal'],
            ['حلال', 'halal'],
            ['K.O.S.H.E.R', 'kosher'],
            ['vegan', 'vegan'],
          ]
        : [
            ['q-o-r-v-a-n-e', 'qorvane'],
            ['zedpure', 'zedpure'],
          ];
    const result = await matchClaimTerms.execute(anonymous(), {
      texts: probes.map(([text]) => ({
        locale: markets.get(market.marketId).defaultLocale,
        text: text!,
      })),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    probes.forEach(([, type], index) => {
      expect(result.value[index]!.map((m) => m.typeCode)).toContain(type);
    });
  });

  it('is refused for every caller but the system', async () => {
    const result = await useCase.execute(anonymous(), {});
    expect(result.ok).toBe(false);
  });
});
