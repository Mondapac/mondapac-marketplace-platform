import { devNull } from 'node:os';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pino from 'pino';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { AppModule } from '../../src/app.module';
import type { CommissionPayoutsDependencies } from '../../src/modules/commission-payouts/application/commission-payouts-dependencies';
import {
  CommissionRateReverter,
  PayoutTermsReverter,
} from '../../src/modules/commission-payouts/application/money-reverters';
import { PayoutTermsResolver } from '../../src/modules/commission-payouts/application/payout-terms-resolver';
import { ClearSellerPayoutTerms } from '../../src/modules/commission-payouts/application/use-cases/clear-seller-payout-terms.use-case';
import { SetCommissionRate } from '../../src/modules/commission-payouts/application/use-cases/set-commission-rate.use-case';
import { SetSellerPayoutTerms } from '../../src/modules/commission-payouts/application/use-cases/set-seller-payout-terms.use-case';
import { ConfigCommissionPolicy } from '../../src/modules/commission-payouts/infrastructure/config-commission-policy';
import { ConfigPayoutTermsPolicy } from '../../src/modules/commission-payouts/infrastructure/config-payout-terms-policy';
import { PrismaEligibilityAnchorRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-eligibility-anchor.repository';
import { PrismaLedgerRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-ledger.repository';
import { PrismaPayoutCursorRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-payout-cursor.repository';
import { PrismaPayoutHoldRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-payout-hold.repository';
import { PrismaPayoutTermsRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-payout-terms.repository';
import { PrismaSellerRateRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-seller-rate.repository';
import {
  SYSTEM_REQUEST_RECORDER,
  SystemRequestsModule,
  type SystemRequestRecorder,
} from '../../src/modules/system-requests';
import {
  REQUEST_REPOSITORY,
  type RequestRepository,
} from '../../src/modules/system-requests/application/ports/request.repository';
import type { AuditEntry } from '@mondapac/shared-kernel';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaService } from '../../src/platform/persistence/prisma.service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import {
  testAppConfig,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../support/test-config';
import { marketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Area money of Admin Inbox › System requests on the real recorder and the real commission-payouts
// stores, in both Market fixtures (money is reviewed by default): a change without a note leaves
// nothing behind, a change with one opens its request in the same unit, and the reverters restore
// the rate and the payout terms, then answer changed-since. Sellers are new per test, so nothing
// here meets another spec's rows.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

describe.each(TEST_MARKETS)('money reviews in market %s (database)', (code) => {
  const market = marketOf(code);
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
  let deps: CommissionPayoutsDependencies;
  let requests: RequestRepository;
  let sql: Client;
  const audit: AuditEntry[] = [];

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
    const prisma = app.get(PrismaService);
    const reviews = app.select(SystemRequestsModule);
    const termsOverrides = new PrismaPayoutTermsRepository(prisma);
    deps = {
      unitOfWork: app.get<UnitOfWork>(UNIT_OF_WORK),
      rates: new PrismaSellerRateRepository(prisma),
      ledger: new PrismaLedgerRepository(prisma),
      policy: new ConfigCommissionPolicy(markets),
      termsOverrides,
      terms: new PayoutTermsResolver(new ConfigPayoutTermsPolicy(markets), termsOverrides),
      anchors: new PrismaEligibilityAnchorRepository(prisma),
      holds: new PrismaPayoutHoldRepository(prisma),
      disputes: { decisionsForSeller: () => Promise.resolve([]) },
      sellers: { exists: () => Promise.resolve(true) },
      cursors: new PrismaPayoutCursorRepository(prisma),
      // The terms-change event is checked by the unit specs; here only the stores are real.
      outbox: { append: () => Promise.resolve() },
      stepUp: {
        consume: (context) =>
          Promise.resolve(
            ok({
              sessionId: (context.actor as { sessionId: Id<'Session'> }).sessionId,
              verifiedAt: clock.now(),
            }),
          ),
      },
      audit: {
        record: (_context, entry) => {
          audit.push(entry);
          return Promise.resolve();
        },
      },
      review: reviews.get<SystemRequestRecorder>(SYSTEM_REQUEST_RECORDER, { strict: true }),
      ids,
      clock,
    };
    requests = reviews.get<RequestRepository>(REQUEST_REPOSITORY, { strict: true });
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
  const rateRow = async (sellerId: Id<'Seller'>) =>
    (
      await sql.query<{ rate_bps: number }>(
        'SELECT rate_bps FROM commission_payouts.seller_commission_rates WHERE market_id = $1 AND seller_id = $2',
        [market.marketId, sellerId],
      )
    ).rows[0] ?? null;

  it('keeps nothing of a rate change without a note, and reverts one with its request', async () => {
    const seller = ids.next<'Seller'>();
    const author = admin('money-db-author');
    const refused = await new SetCommissionRate(gate, deps).execute(author, {
      sellerId: seller,
      rateBps: 1100,
    });
    expect(!refused.ok && refused.error.code).toBe('validation.failed');
    expect(await rateRow(seller)).toBeNull();

    const saved = await new SetCommissionRate(gate, deps).execute(author, {
      sellerId: seller,
      rateBps: 1100,
      note: 'Launch deal',
    });
    if (!saved.ok || saved.value.request === null) throw new Error('no request opened');
    expect(await rateRow(seller)).toEqual({ rate_bps: 1100 });
    const id = saved.value.request.id;
    expect(await inUnit(() => requests.find(market, id))).toMatchObject({
      status: 'open',
      area: 'money',
      risk: 'high',
      subjectKind: 'commission-payouts.commission-rate',
      subjectRef: seller,
      before: { rateBps: null },
      after: { rateBps: 1100 },
    });

    const reverter = new CommissionRateReverter(deps);
    const request = {
      requestId: id,
      subjectRef: seller,
      before: { rateBps: null },
      after: { rateBps: 1100 },
    };
    const reviewer = admin('money-db-reviewer');
    expect(await inUnit(() => reverter.revert(reviewer, request))).toBe('reverted');
    expect(await rateRow(seller)).toBeNull();
    expect(audit.at(-1)).toMatchObject({
      action: 'commission-payouts.commission-rate.reverted',
      after: { rateBps: null, requestId: id },
    });
    expect(await inUnit(() => reverter.revert(reviewer, request))).toBe('changed-since');
  });

  it('reverts payout terms on the real store, as a new version and then a removal', async () => {
    const seller = ids.next<'Seller'>();
    const author = admin('money-db-terms');
    const set = (terms: object, expectedVersion: number | null) =>
      new SetSellerPayoutTerms(gate, deps).execute(author, {
        sellerId: seller,
        terms,
        expectedVersion,
        reasonCode: 'correction',
        note: 'Seller asked',
      });
    const first = await set({ holdDaysCarrier: 9 }, null);
    const second = await set({ holdDaysCarrier: 12 }, 1);
    if (!first.ok || !second.ok || second.value.request === null) throw new Error('not saved');
    const values = (holdDaysCarrier: number) => ({
      weekdays: null,
      localTime: null,
      holdDaysCarrier,
      holdDaysSellerClick: null,
      minimumMinor: null,
      approvalMode: null,
    });
    const reverter = new PayoutTermsReverter(deps);
    const reviewer = admin('money-db-terms-reviewer');
    const back = {
      requestId: second.value.request.id,
      subjectRef: seller,
      before: { terms: values(9) },
      after: { terms: values(12) },
    };
    expect(await inUnit(() => reverter.revert(reviewer, back))).toBe('reverted');
    expect(await inUnit(() => deps.termsOverrides.find(market, seller))).toMatchObject({
      version: 3,
      override: { holdDaysCarrier: 9 },
    });
    expect(await inUnit(() => reverter.revert(reviewer, back))).toBe('changed-since');
    const removed = await inUnit(() =>
      reverter.revert(reviewer, { ...back, before: { terms: null }, after: { terms: values(9) } }),
    );
    expect(removed).toBe('reverted');
    expect(await inUnit(() => deps.termsOverrides.find(market, seller))).toBeNull();
    // A clear needs a version the seller no longer has: nothing to remove.
    const clear = await new ClearSellerPayoutTerms(gate, deps).execute(author, {
      sellerId: seller,
      expectedVersion: 3,
      reasonCode: 'policy',
      note: 'x',
    });
    expect(!clear.ok && clear.error.code).toBe('commission-payouts.terms-not-set');
  });
});
