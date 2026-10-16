import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Id } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { CustomerAccountSummaries } from '../../src/modules/identity/application/use-cases/customer-account-summaries.use-case';
import { FindCustomerAccount } from '../../src/modules/identity/application/use-cases/find-customer-account.use-case';
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Identity slice 8d on PostgreSQL (identity design 12.1 `identity.customer-account.view`), for
// both Market fixtures, as the application role: customer lookup by exact email through the real
// gate, use case and Prisma ports, in a read-only unit, against rows of both Markets.

const CREATED = '2026-10-08T00:00:00Z';
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn';
const ID_PREFIX = '01990000-0000-7000-8000-';
const newId = <T extends string>(): Id<T> =>
  `${ID_PREFIX}${randomBytes(6).toString('hex')}` as Id<T>;

describe.each(TEST_MARKETS)('customer lookup in market %s (database, slice 8d)', (code) => {
  const market = marketOf(code);
  let app: NestExpressApplication;
  let sql: Client;
  let db: Persistence;
  let logs: jest.SpyInstance[];

  beforeAll(async () => {
    ({ app } = await createTestApp({ env: { DATABASE_URL: testDatabaseUrl() } }));
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    db = createPersistence();
    for (const each of [market, marketOf(otherMarketOf(code))]) {
      await app
        .get(SeedRoles)
        .execute(testCallContext(each, 'system', `db-find-customer-${randomUUID()}`), {});
    }
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
    await app.close();
  });
  beforeEach(() => {
    logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });
  afterEach(() => logs.forEach((spy) => spy.mockRestore()));

  async function account(
    population: 'admin' | 'customer',
    email: string,
    options: {
      marketCode?: string;
      status?: 'active' | 'disabled';
      verified?: boolean;
      credential?: boolean;
    } = {},
  ): Promise<Id<'Account'>> {
    const id = newId<'Account'>();
    const marketCode = options.marketCode ?? code;
    await sql.query(
      `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
       email_normalized, display_name, status, email_verified_at, signed_up_at, version, created_at)
       VALUES ($1, $2, 'default', $3, $4, $5, $6, $7, $8, $9, 1, $9)`,
      [
        id,
        marketCode,
        population,
        email,
        email.trim().toLowerCase(),
        population === 'admin' ? 'Team Member' : null,
        options.status ?? 'active',
        options.verified === false ? null : CREATED,
        CREATED,
      ],
    );
    if (options.credential === false) return id;
    await sql.query(
      `INSERT INTO identity.password_credentials
         (market_id, tenant_id, account_id, password_hash, changed_at)
       VALUES ($1, 'default', $2, $3, $4)`,
      [marketCode, id, PASSWORD_HASH, CREATED],
    );
    return id;
  }

  async function admin(seedCode: string): Promise<Id<'Account'>> {
    const id = await account('admin', `admin.${randomUUID()}@lookup.example`);
    const { rows } = await sql.query<{ id: string }>(
      `SELECT id FROM identity.roles WHERE market_id = $1 AND scope = 'platform' AND seed_code = $2`,
      [code, seedCode],
    );
    await sql.query(
      `INSERT INTO identity.role_assignments (id, market_id, tenant_id, account_id, role_id,
       assigned_by_account_id, assigned_at, version)
       VALUES ($1, $2, 'default', $3, $4, NULL, $5, 1)`,
      [newId(), code, id, rows[0]!.id, CREATED],
    );
    return id;
  }

  const as = (accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId,
        sessionId: newId<'Session'>(),
        sellerId: null,
      }),
      `db-find-customer-${randomUUID()}`,
    );

  it('finds a customer by a mixed-case, padded email; a disabled unverified one as it is', async () => {
    const root = await admin('platform-administrator');
    const tag = randomUUID();
    const active = await account('customer', `Jane.${tag}@Lookup.Example`);
    const disabled = await account('customer', `Off.${tag}@Lookup.Example`, {
      status: 'disabled',
      verified: false,
    });
    const find = app.get(FindCustomerAccount);

    const found = await find.execute(as(root), { email: `  JANE.${tag}@lookup.example ` });
    const off = await find.execute(as(root), { email: `off.${tag}@lookup.example` });

    expect(found).toMatchObject({
      ok: true,
      value: {
        accountId: active,
        email: `Jane.${tag}@Lookup.Example`,
        status: 'active',
        emailVerified: true,
      },
    });
    expect(off).toMatchObject({
      ok: true,
      value: { accountId: disabled, status: 'disabled', emailVerified: false },
    });
  });

  it('answers the order-page summaries in one batch, past a malformed id and a customer without a credential', async () => {
    const root = await admin('platform-administrator');
    const tag = randomUUID();
    const plain = await account('customer', `Plain.${tag}@Lookup.Example`);
    const bare = await account('customer', `Bare.${tag}@Lookup.Example`, { credential: false });
    const abroad = await account('customer', `Away.${tag}@Lookup.Example`, {
      marketCode: otherMarketOf(code),
    });
    const staff = await account('admin', `Staff.${tag}@Lookup.Example`);

    const answer = await app.get(CustomerAccountSummaries).execute(as(root), {
      // A version 4 UUID is not an id here: skipped, never a failure of the batch.
      accountIds: [plain, randomUUID(), bare, abroad, staff],
    });

    expect(answer.ok).toBe(true);
    expect(answer.ok && [...answer.value].sort((x, y) => x.email.localeCompare(y.email))).toEqual([
      { accountId: bare, displayName: null, email: `Bare.${tag}@Lookup.Example` },
      { accountId: plain, displayName: null, email: `Plain.${tag}@Lookup.Example` },
    ]);
  });

  it('answers the same customer.not-found for unknown, other-Market, admin and partial emails', async () => {
    const root = await admin('platform-administrator');
    const tag = randomUUID();
    await account('customer', `abroad.${tag}@lookup.example`, { marketCode: otherMarketOf(code) });
    await account('customer', `here.${tag}@lookup.example`);
    const find = app.get(FindCustomerAccount);

    const answers = [];
    for (const email of [
      `nobody.${tag}@lookup.example`,
      `abroad.${tag}@lookup.example`,
      `here.${tag}@lookup`,
      `here@lookup.example`,
      `admin.${tag}@lookup.example`,
    ]) {
      answers.push(await find.execute(as(root), { email }));
    }

    for (const answer of answers) {
      expect(answer).toEqual({ ok: false, error: { code: 'customer.not-found' } });
    }
  });

  it('refuses an admin without the view key and writes nothing to the logs for the address', async () => {
    const finance = await admin('finance');
    const support = await admin('operations-support');
    const tag = randomUUID();
    await account('customer', `secret.${tag}@lookup.example`);
    const find = app.get(FindCustomerAccount);

    const denied = await find.execute(as(finance), { email: `secret.${tag}@lookup.example` });
    const allowed = await find.execute(as(support), { email: `secret.${tag}@lookup.example` });

    expect(denied).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(allowed).toMatchObject({ ok: true });
    await find.execute(as(support), { email: `missing.${tag}@lookup.example` });
    const logged = JSON.stringify(logs.map((spy) => spy.mock.calls as unknown[])).toLowerCase();
    expect(logged).not.toContain(tag.toLowerCase());
  });
});
