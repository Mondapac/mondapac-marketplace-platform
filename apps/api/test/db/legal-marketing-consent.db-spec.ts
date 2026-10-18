import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { MarketingEmailConsentOf } from '../../src/modules/legal/application/use-cases/marketing-email-consent-of.use-case';
import { SetEmailPreferences } from '../../src/modules/legal/application/use-cases/set-email-preferences.use-case';
import { WithdrawMarketingEmailByLink } from '../../src/modules/legal/application/use-cases/withdraw-marketing-email-by-link.use-case';
import { PrismaMarketingConsentRepository } from '../../src/modules/legal/infrastructure/prisma-marketing-consent.repository';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The marketing consent store as the application role, in both Market fixtures: the real use
// cases on the real unit of work record a change once (current row and history), never read
// across Markets or accounts, and keep one row per account under concurrent writes; the CHECKs
// refuse an unknown channel or source.

const T0 = Temporal.Instant.from('2026-10-18T09:00:00Z');
const CHECK = '23514';
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

describe.each(TEST_MARKETS)('marketing consent store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  let db: Persistence;
  let consents: PrismaMarketingConsentRepository;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    consents = new PrismaMarketingConsentRepository(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  const deps = () => ({ unitOfWork: db.unitOfWork, consents, ids, clock });
  const customer = (target: MarketContext, accountId: Id<'Account'>) =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population: 'customer',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
      'leg-db-abcd',
    );
  const value = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const historyOf = async (accountId: string) =>
    (
      await sql.query<{ granted: boolean; source: string; market_id: string }>(
        `SELECT granted, source, market_id FROM legal.marketing_consent_changes
          WHERE account_id = $1 ORDER BY occurred_at, id`,
        [accountId],
      )
    ).rows;

  it('records an opt-in and a link withdrawal once each, scoped to the Market and account', async () => {
    const alice = ids.next<'Account'>();
    const set = new SetEmailPreferences(gate, deps());
    const consentOf = new MarketingEmailConsentOf(gate, deps());
    const withdraw = new WithdrawMarketingEmailByLink(gate, deps());
    const system = testCallContext(market, 'system');

    expect(
      await set.execute(customer(market, alice), { marketing: true, source: 'sign-up' }),
    ).toMatchObject({
      ok: true,
      value: { marketing: true },
    });
    await set.execute(customer(market, alice), { marketing: true });
    expect(await consentOf.execute(system, { accountId: alice })).toEqual({
      ok: true,
      value: { granted: true },
    });
    expect(await consentOf.execute(testCallContext(other, 'system'), { accountId: alice })).toEqual(
      { ok: true, value: { granted: false } },
    );
    expect(
      await value(market, () => consents.find(market, ids.next<'Account'>(), 'email')),
    ).toBeNull();

    // Ids are not ordered inside one millisecond: the history is ordered by its time.
    clock.advance(Temporal.Duration.from({ seconds: 1 }));
    const anonymous = testCallContext(market, 'anonymous');
    expect(await withdraw.execute(anonymous, { accountId: alice })).toEqual({
      ok: true,
      value: { withdrawn: true },
    });
    expect(await withdraw.execute(anonymous, { accountId: alice })).toEqual({
      ok: true,
      value: { withdrawn: false },
    });
    expect(await value(market, () => consents.find(market, alice, 'email'))).toMatchObject({
      granted: false,
      source: 'unsubscribe-link',
    });
    expect(await historyOf(alice)).toEqual([
      { granted: true, source: 'sign-up', market_id: code },
      { granted: false, source: 'unsubscribe-link', market_id: code },
    ]);
  });

  it('keeps one row per account when the same customer saves at the same time', async () => {
    const accountId = ids.next<'Account'>();
    const set = new SetEmailPreferences(gate, deps());
    const results = await Promise.all(
      [true, true, true, true].map((marketing) =>
        set.execute(customer(market, accountId), { marketing }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const rows = await sql.query(
      'SELECT count(*)::int AS n FROM legal.marketing_consents WHERE account_id = $1',
      [accountId],
    );
    expect(rows.rows[0]).toEqual({ n: 1 });
    expect(await historyOf(accountId)).toHaveLength(1);
  });

  it('refuses an unknown channel or source at the database', async () => {
    const insertRow = (channel: string, source: string) =>
      sql
        .query(
          `INSERT INTO legal.marketing_consent_changes (id, market_id, tenant_id, account_id, channel, granted, source, occurred_at)
           VALUES ($1, $2, $3, $4, $5, true, $6, now())`,
          [ids.next(), market.marketId, market.tenantId, ids.next(), channel, source],
        )
        .then(
          () => 'allowed',
          (error: { code?: string }) => error.code,
        );
    expect(await insertRow('sms', 'account')).toBe(CHECK);
    expect(await insertRow('email', 'admin')).toBe(CHECK);
    expect(await insertRow('email', 'account')).toBe('allowed');
  });
});
