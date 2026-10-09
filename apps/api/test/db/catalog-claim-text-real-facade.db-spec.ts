import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { CheckClaimText } from '../../src/modules/catalog/application/claim-text/check-claim-text.service';
import { HmacRateCounterKeys } from '../../src/modules/catalog/infrastructure/hmac-rate-counter-keys';
import { CertificationClaimTextMatcher } from '../../src/modules/catalog/infrastructure/certification-claim-text-matcher';
import { ConfigCatalogMarketPolicy } from '../../src/modules/catalog/infrastructure/config-catalog-market-policy';
import { MatchClaimTerms } from '../../src/modules/certification/application/use-cases/match-claim-terms.use-case';
import { MatchClaimTermsSystem } from '../../src/modules/certification/application/use-cases/match-claim-terms-system.use-case';
import { PrismaPublishedTypesReader } from '../../src/modules/certification/infrastructure/prisma-published-types.reader';
import { UnitPublishedTypesReader } from '../../src/modules/certification/infrastructure/unit-published-types.reader';
import { CertificationFacadeImplementation } from '../../src/modules/certification/presentation/certification.facade';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { catalogClaimsOwnerTestDatabaseUrl, catalogClaimsTestDatabaseUrl } from './test-database';

// ADR-0031 decision 3: the claim-text check of catalog through the REAL certification facade
// (the use cases, the gate, the Prisma reader of the published vocabulary), on its own copy of
// the run database, for both Market fixtures. An empty vocabulary is unavailable, a seeded term is
// found, clean text passes, and the system actor's seed check answers the same way.

const T0 = '2026-10-08T00:00:00Z';
const TERM = 'zzcertified';
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)('catalog claim-text check, real facade, market %s', (code) => {
  const market: MarketContext = marketOf(code);
  let persistence: Persistence;
  let owner: Client;
  let service: CheckClaimText;
  let locale: string;

  const admin = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: uuid7() as Id<'Account'>,
        sessionId: uuid7() as Id<'Session'>,
        sellerId: null,
      }),
    );
  const system = (): CallContext => testCallContext(market, 'system');
  const item = (text: string) => ({
    field: 'platform-category.name' as const,
    ref: 'c1',
    locale,
    text,
  });

  beforeAll(async () => {
    persistence = createPersistence({ databaseUrl: catalogClaimsTestDatabaseUrl() });
    owner = new Client({ connectionString: catalogClaimsOwnerTestDatabaseUrl() });
    await owner.connect();
    const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
    const policy = new ConfigCatalogMarketPolicy(markets);
    locale = policy.locales(market).default;
    const gate = createUseCaseGate(markets, null);
    const reader = new UnitPublishedTypesReader(
      persistence.unitOfWork,
      new PrismaPublishedTypesReader(persistence.service),
    );
    const facade = new CertificationFacadeImplementation({
      matchClaimTerms: new MatchClaimTerms(gate, reader),
      matchClaimTermsSystem: new MatchClaimTermsSystem(gate, reader),
    } as never);
    service = new CheckClaimText({
      unitOfWork: persistence.unitOfWork,
      matcher: new CertificationClaimTextMatcher(facade),
      counters: {
        reserve: () => Promise.reject(new Error('no counter is spent')),
        purgeStartedBefore: () => Promise.resolve(0),
      },
      counterKeys: new HmacRateCounterKeys(new Uint8Array(32).fill(7)),
      policy,
      clock: new FixedClock(Temporal.Instant.from(T0)),
    });
  });
  afterAll(async () => {
    await owner.end();
    await persistence.close();
  });

  async function seedType(typeCode: string): Promise<void> {
    const typeId = uuid7();
    const revisionId = uuid7();
    const scope = [market.marketId, market.tenantId];
    await owner.query('BEGIN');
    try {
      await owner.query(
        `INSERT INTO certification.certification_types
           (id, market_id, tenant_id, code, verification_mode, status, published_revision_id, version, created_at)
         VALUES ($1, $2, $3, $4, 'THIRD_PARTY_DOCUMENT', 'active', NULL, 1, $5)`,
        [typeId, ...scope, typeCode, T0],
      );
      await owner.query(
        `INSERT INTO certification.certification_type_revisions
           (id, market_id, tenant_id, type_id, revision_no, verification_mode, requires_issuer_registry,
            requires_document, requires_expiry, default_basis, auto_approve_self_declaration,
            badge_icon_key, author_account_id, created_at)
         VALUES ($1, $2, $3, $4, 1, 'THIRD_PARTY_DOCUMENT', true, true, true, 'SELLER_REQUIRED', false,
                 'halal', $5, $6)`,
        [revisionId, ...scope, typeId, uuid7(), T0],
      );
      await owner.query(
        `INSERT INTO certification.type_revision_texts
           (market_id, tenant_id, type_revision_id, locale, name, customer_description)
         VALUES ($1, $2, $3, $4, 'Name', 'Description')`,
        [...scope, revisionId, locale],
      );
      await owner.query(
        `INSERT INTO certification.claim_terms (market_id, tenant_id, type_revision_id, locale, phrase)
         VALUES ($1, $2, $3, $4, $5)`,
        [...scope, revisionId, locale, TERM],
      );
      await owner.query(
        `UPDATE certification.certification_types SET published_revision_id = $1 WHERE id = $2`,
        [revisionId, typeId],
      );
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
  }

  // Order matters: the first case meets a Market with no published vocabulary.
  it('is unavailable while the Market has no published vocabulary (fail closed)', async () => {
    for (const context of [admin(), system()]) {
      const result =
        context.actor.kind === 'system'
          ? await service.executeAsSystem(context, [item('a plain name')])
          : await service.execute(context, [item('a plain name')]);
      expect(result).toEqual({
        ok: true,
        value: [
          {
            code: 'claim-text.check-unavailable',
            field: 'platform-category.name',
            ref: 'c1',
            locale,
          },
        ],
      });
    }
  });

  it('finds a seeded term and passes clean text, for an admin and for the seed check', async () => {
    await seedType(`ztype-${code.toLowerCase()}`);
    const texts = [item(`A ${TERM} name`), item('A plain name')];
    for (const run of [
      () => service.execute(admin(), texts),
      () => service.executeAsSystem(system(), texts),
    ]) {
      const result = await run();
      if (!result.ok) throw new Error(result.error.code);
      expect(result.value.map((verdict) => verdict.code)).toEqual(['claim-text.found', 'clean']);
      const found = result.value[0];
      expect(found && 'hits' in found ? found.hits.map((hit) => hit.typeCode) : []).toEqual([
        `ztype-${code.toLowerCase()}`,
      ]);
    }
  });

  it('refuses a whole batch when one text grows past the matcher limit', async () => {
    const long = 'ﬃ'.repeat(10_000); // 10,000 characters that expand under NFKC
    const result = await service.execute(admin(), [item('a plain name'), item(long)]);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.map((verdict) => verdict.code)).toEqual([
      'claim-text.check-unavailable',
      'claim-text.check-unavailable',
    ]);
  });
});
