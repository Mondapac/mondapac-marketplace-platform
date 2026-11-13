import { randomBytes } from 'node:crypto';
import { ok } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaAccountRepository } from '../../src/modules/identity/infrastructure/prisma-account.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The customer-name search of identity's account store (the admin order list) on PostgreSQL, for
// both Market fixtures: contained text, any case, `%` and `_` taken literally, customers of this
// Market only, and the limit.

const CREATED = '2026-10-08T00:00:00Z';
const newId = (): Id<'Account'> =>
  `01990000-0000-7000-8000-${randomBytes(6).toString('hex')}` as Id<'Account'>;

describe.each(TEST_MARKETS)('customer-name search in market %s (database)', (code) => {
  const market = marketOf(code);
  let db: Persistence;
  let sql: Client;
  let accounts: PrismaAccountRepository;
  // A name nobody else uses, so rows of other specs never match.
  const tag = randomBytes(4).toString('hex');

  async function account(
    population: 'admin' | 'customer',
    displayName: string,
    marketCode: string = code,
  ): Promise<Id<'Account'>> {
    const id = newId();
    const email = `${id}@search.example`;
    await sql.query(
      `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
       email_normalized, display_name, status, email_verified_at, signed_up_at, version, created_at)
       VALUES ($1, $2, 'default', $3, $4, $4, $5, 'active', $6, $6, 1, $6)`,
      [id, marketCode, population, email, displayName, CREATED],
    );
    return id;
  }

  beforeAll(async () => {
    db = createPersistence();
    accounts = new PrismaAccountRepository(db.service, {} as never); // the search reads no subject key
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  const find = async (term: string, limit = 10) => {
    const result = await db.unitOfWork.run(
      market,
      async () => ok(await accounts.searchCustomerIdsByName(market, term, limit)),
      { readOnly: true },
    );
    if (!result.ok) throw new Error('unreachable');
    return result.value;
  };

  it('finds customers of this Market by contained text, taking % and _ literally', async () => {
    const jane = await account('customer', `Jane ${tag} Citizen`);
    const pct = await account('customer', `${tag} 100% Fan_Club`);
    await account('admin', `Admin ${tag} Citizen`);
    await account('customer', `Jane ${tag} Citizen`, otherMarketOf(code));

    expect(await find(`${tag} citizen`)).toEqual([jane]);
    expect(await find(`${tag}`)).toEqual([jane, pct].sort());
    expect(await find('%%')).toEqual([]);
    expect(await find('__')).toEqual([]);
    expect(await find(`${tag} 100% fan_`)).toEqual([pct]);
    expect(await find(tag, 1)).toHaveLength(1);
  });
});
