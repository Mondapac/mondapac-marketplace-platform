import { randomUUID } from 'node:crypto';
import { Client, DatabaseError } from 'pg';
import { TEST_MARKETS } from '../support/test-config';
import { testDatabaseUrl } from './test-database';

// The constraints of `identity.accounts` and `identity.password_credentials` (data design
// docs/design/data/identity.md 3.3, C1, C3, C5, and N1 in 11.5), as the application role, for
// both Market fixtures. It repeats Mojtaba's measured cases (section 10): a customer may have
// no display name, a seller-side or admin account may not, at insert or at update; a present
// name obeys the same CHECK in every population.

const POPULATIONS = ['customer', 'seller', 'admin'] as const;
type Population = (typeof POPULATIONS)[number];

interface AccountRow {
  readonly id?: string;
  readonly market?: string;
  readonly population?: Population;
  readonly email?: string;
  readonly emailNormalized?: string;
  readonly displayName?: string | null;
  readonly signedUpAt?: string;
  readonly createdAt?: string;
  readonly version?: number;
}

const CREATED = '2026-10-07T00:00:00Z';

describe('identity.accounts and password_credentials (database constraints)', () => {
  let sql: Client;

  beforeAll(async () => {
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
  });

  async function insertAccount(market: string, row: AccountRow = {}): Promise<string> {
    const id = row.id ?? randomUUID();
    const email = row.email ?? `${id}@example.com`;
    await sql.query(
      `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
         email_normalized, display_name, status, signed_up_at, version, created_at)
       VALUES ($1, $2, 'default', $3, $4, $5, $6, 'active', $7, $8, $9)`,
      [
        id,
        row.market ?? market,
        row.population ?? 'customer',
        email,
        row.emailNormalized ?? email.toLowerCase(),
        row.displayName === undefined ? null : row.displayName,
        row.signedUpAt ?? CREATED,
        row.version ?? 1,
        row.createdAt ?? CREATED,
      ],
    );
    return id;
  }

  /** The constraint a statement violated, or null when it succeeded. */
  async function violated(statement: Promise<unknown>): Promise<string | null> {
    try {
      await statement;
      return null;
    } catch (error) {
      if (error instanceof DatabaseError) return error.constraint ?? error.code ?? 'unknown';
      throw error;
    }
  }

  describe.each(TEST_MARKETS)('in market %s', (market) => {
    describe('display name (N1)', () => {
      it('accepts a customer without a display name', async () => {
        expect(await violated(insertAccount(market, { population: 'customer' }))).toBeNull();
      });

      it.each(['seller', 'admin'] as const)(
        'refuses a %s without one at insert',
        async (population) => {
          expect(await violated(insertAccount(market, { population }))).toBe(
            'accounts_display_name_required_check',
          );
        },
      );

      it.each(['seller', 'admin'] as const)(
        'refuses removing the name of a %s at update',
        async (population) => {
          const id = await insertAccount(market, { population, displayName: 'Shop Owner' });

          expect(
            await violated(
              sql.query(
                'UPDATE identity.accounts SET display_name = NULL WHERE market_id = $1 AND id = $2',
                [market, id],
              ),
            ),
          ).toBe('accounts_display_name_required_check');
        },
      );

      it.each(POPULATIONS)('accepts a valid name for a %s', async (population) => {
        expect(
          await violated(insertAccount(market, { population, displayName: 'عائشة Rahman' })),
        ).toBeNull();
      });

      describe.each(POPULATIONS)('for a %s', (population) => {
        it.each([
          ['an empty name', ''],
          ['an outer space', ' Name'],
          ['a right-to-left override', 'Na\u202eme'],
          ['101 characters', 'n'.repeat(101)],
        ])('refuses %s', async (_case, displayName) => {
          expect(await violated(insertAccount(market, { population, displayName }))).toBe(
            'accounts_display_name_check',
          );
        });
      });
    });

    describe('email', () => {
      it('is unique per Market and population, and free for the other population', async () => {
        const email = `${randomUUID()}@example.com`;
        await insertAccount(market, { email });

        expect(await violated(insertAccount(market, { email }))).toBe(
          'accounts_market_id_population_email_normalized_key',
        );
        expect(
          await violated(insertAccount(market, { email, population: 'seller', displayName: 'S' })),
        ).toBeNull();
      });

      it.each([
        ['ASCII upper case', 'Upper@Example.com'],
        ['an outer space', ' outer@example.com'],
        ['a decomposed accent', 'zélie@example.com'],
        ['no local part', '@example.com'],
      ])('refuses a normalised email with %s', async (_case, emailNormalized) => {
        expect(await violated(insertAccount(market, { emailNormalized }))).toBe(
          'accounts_email_normalized_check',
        );
      });
    });

    describe('other columns', () => {
      it('refuses a sign-up before the creation, version 0, an unknown population', async () => {
        expect(await violated(insertAccount(market, { signedUpAt: '2026-10-06T23:59:59Z' }))).toBe(
          'accounts_signed_up_at_check',
        );
        expect(await violated(insertAccount(market, { version: 0 }))).toBe(
          'accounts_version_check',
        );
        expect(
          await violated(
            insertAccount(market, { population: 'guest' as Population, displayName: 'G' }),
          ),
        ).toBe('accounts_population_check');
        expect(await violated(insertAccount(market, { market: 'au' }))).toBe(
          'accounts_market_id_check',
        );
      });
    });

    describe('password credential', () => {
      const insertCredential = (credentialMarket: string, accountId: string, hash: string) =>
        sql.query(
          `INSERT INTO identity.password_credentials
             (market_id, tenant_id, account_id, password_hash, changed_at)
           VALUES ($1, 'default', $2, $3, $4)`,
          [credentialMarket, accountId, hash, CREATED],
        );
      const PHC = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn';

      it('accepts one PHC string per account and refuses a second', async () => {
        const id = await insertAccount(market);

        expect(await violated(insertCredential(market, id, PHC))).toBeNull();
        expect(await violated(insertCredential(market, id, PHC))).toBe('password_credentials_pkey');
      });

      it('refuses a raw password and an over-long value', async () => {
        const id = await insertAccount(market);

        expect(await violated(insertCredential(market, id, 'hunter2-plain-password'))).toBe(
          'password_credentials_password_hash_check',
        );
        expect(await violated(insertCredential(market, id, `$argon2id$${'a'.repeat(250)}`))).toBe(
          'password_credentials_password_hash_check',
        );
      });

      it('refuses a credential in another Market than its account (C3)', async () => {
        const id = await insertAccount(market);
        const other = TEST_MARKETS.find((code) => code !== market)!;

        expect(await violated(insertCredential(other, id, PHC))).toBe(
          'password_credentials_market_id_account_id_fkey',
        );
      });

      it('goes with its account: the cascade needs no DELETE grant on the child', async () => {
        const id = await insertAccount(market);
        await insertCredential(market, id, PHC);

        await sql.query('DELETE FROM identity.accounts WHERE market_id = $1 AND id = $2', [
          market,
          id,
        ]);
        const { rowCount } = await sql.query(
          'SELECT 1 FROM identity.password_credentials WHERE market_id = $1 AND account_id = $2',
          [market, id],
        );
        expect(rowCount).toBe(0);
      });

      it('cannot be deleted by the application directly', async () => {
        const id = await insertAccount(market);
        await insertCredential(market, id, PHC);

        expect(
          await violated(
            sql.query('DELETE FROM identity.password_credentials WHERE account_id = $1', [id]),
          ),
        ).toBe('42501');
      });
    });
  });
});
