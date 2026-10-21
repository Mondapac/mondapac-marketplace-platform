import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Id } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { ChangeDisplayName } from '../../src/modules/identity/application/use-cases/change-display-name.use-case';
import { ChangeStorefrontAppearance } from '../../src/modules/identity/application/use-cases/change-storefront-appearance.use-case';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The customer profile on PostgreSQL (buyer account backend), for both Market fixtures, as the
// application role: the display name and the storefront look through the real gate, use cases
// and account repository, read back from the row and through the repository again.

const CREATED = '2026-10-08T00:00:00Z';
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn';
const newId = <T extends string>(): Id<T> =>
  `01990000-0000-7000-8000-${randomBytes(6).toString('hex')}` as Id<T>;

interface ProfileRow {
  display_name: string | null;
  storefront_palette: string | null;
  storefront_text_size: string | null;
  version: number;
}

describe.each(TEST_MARKETS)('customer profile in market %s (database)', (code) => {
  const market = marketOf(code);
  let app: NestExpressApplication;
  let sql: Client;
  let logs: jest.SpyInstance[];

  beforeAll(async () => {
    ({ app } = await createTestApp({ env: { DATABASE_URL: testDatabaseUrl() } }));
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await sql.end();
    await app.close();
  });
  beforeEach(() => {
    logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });
  afterEach(() => logs.forEach((spy) => spy.mockRestore()));

  async function customer(): Promise<Id<'Account'>> {
    const id = newId<'Account'>();
    const email = `${id}@profile.example`;
    await sql.query(
      `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
       email_normalized, display_name, status, email_verified_at, signed_up_at, version, created_at)
       VALUES ($1, $2, 'default', 'customer', $3, $3, NULL, 'active', $4, $4, 1, $4)`,
      [id, code, email, CREATED],
    );
    await sql.query(
      `INSERT INTO identity.password_credentials
         (market_id, tenant_id, account_id, password_hash, changed_at)
       VALUES ($1, 'default', $2, $3, $4)`,
      [code, id, PASSWORD_HASH, CREATED],
    );
    return id;
  }

  const contextOf = (accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId,
        sessionId: newId<'Session'>(),
        sellerId: null,
      }),
    );
  const rowOf = async (id: string): Promise<ProfileRow> =>
    (
      await sql.query<ProfileRow>(
        `SELECT display_name, storefront_palette, storefront_text_size, version
           FROM identity.accounts WHERE id = $1`,
        [id],
      )
    ).rows[0]!;

  it('stores the name and the look under the version guard, and reads them back', async () => {
    const id = await customer();

    await expect(
      app.get(ChangeDisplayName).execute(contextOf(id), { displayName: 'Amina' }),
    ).resolves.toEqual({ ok: true, value: { code: 'display-name-changed', changed: true } });
    await expect(
      app
        .get(ChangeStorefrontAppearance)
        .execute(contextOf(id), { palette: 'D', textSize: 'large' }),
    ).resolves.toEqual({
      ok: true,
      value: { code: 'storefront-appearance-changed', changed: true },
    });

    expect(await rowOf(id)).toEqual({
      display_name: 'Amina',
      storefront_palette: 'D',
      storefront_text_size: 'large',
      version: 3,
    });

    // Read back through the repository: the same look changes nothing.
    await expect(
      app
        .get(ChangeStorefrontAppearance)
        .execute(contextOf(id), { palette: 'D', textSize: 'large' }),
    ).resolves.toMatchObject({ ok: true, value: { changed: false } });

    await expect(
      app.get(ChangeStorefrontAppearance).execute(contextOf(id), { palette: null, textSize: null }),
    ).resolves.toMatchObject({ ok: true, value: { changed: true } });
    expect(await rowOf(id)).toMatchObject({ storefront_palette: null, storefront_text_size: null });
  });
});
