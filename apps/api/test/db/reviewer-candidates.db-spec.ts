import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { AccountAccessReviewers } from '../../src/modules/identity/application/access/account-access-reviewers';
import type { AccessReviewer } from '../../src/modules/identity/application/ports/access-reviewers';
import { PrismaReviewerCandidateReader } from '../../src/modules/identity/infrastructure/reviewers/prisma-reviewer-candidate-reader';
import { PrismaRoleGrantReader } from '../../src/modules/identity/infrastructure/roles/prisma-role-grant-reader';
import { PrismaSecondFactorRepository } from '../../src/modules/identity/infrastructure/second-factor/prisma-second-factor.repository';
import { realEffectiveKeys } from '../support/permission-registry';
import { ok } from '@mondapac/shared-kernel';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  recordDriverStatements,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The recipient read of the reviewer notice on PostgreSQL (identity design 8.7; request R-3;
// Hassan M2), as the application role, for both Market fixtures: the SQL narrows to the active,
// verified admins of the context's Market by account id, in a read-only unit with no
// transaction (ADR-0025); who may review is decided in code. Since slice 8a-1 the grant read and
// the registry are bound, and since slice 7 the factor store: an admin without an active factor
// is never a recipient. The equivalence with real factors is in second-factor.db-spec.ts.

const CREATED = '2026-10-08T00:00:00Z';

describe.each(TEST_MARKETS)(
  'the reviewer candidates in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    let db: Persistence;
    let sql: Client;
    let reader: PrismaReviewerCandidateReader;
    let driver: ReturnType<typeof recordDriverStatements>;

    beforeAll(async () => {
      db = createPersistence();
      reader = new PrismaReviewerCandidateReader(db.service);
      sql = new Client({ connectionString: testDatabaseUrl() });
      await sql.connect();
      driver = recordDriverStatements();
    });
    afterAll(async () => {
      driver.restore();
      await sql.end();
      await db.close();
    });

    async function insertAccount(
      marketCode: string,
      row: {
        population?: 'customer' | 'seller' | 'admin';
        status?: 'active' | 'disabled';
        verified?: boolean;
      } = {},
    ): Promise<AccessReviewer> {
      const id = randomUUID();
      const email = `Reviewer.${id}@Admin.example`;
      const population = row.population ?? 'admin';
      await sql.query(
        `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
         email_normalized, display_name, status, email_verified_at, signed_up_at, version,
         created_at)
       VALUES ($1, $2, 'default', $3, $4, $5, $6, $7, $8, $9, 1, $9)`,
        [
          id,
          marketCode,
          population,
          email,
          email.toLowerCase(),
          population === 'customer' ? null : 'Reviewer',
          row.status ?? 'active',
          (row.verified ?? true) ? CREATED : null,
          CREATED,
        ],
      );
      return { accountId: id as AccessReviewer['accountId'], email };
    }

    const readOnly = <T>(work: () => Promise<T>) =>
      db.unitOfWork.run(market, async () => ok(await work()), { readOnly: true });

    it('reads only active, verified admins of this Market, by account id, with their typed address', async () => {
      const eligible = [await insertAccount(code), await insertAccount(code)];
      const excluded = [
        await insertAccount(code, { status: 'disabled' }),
        await insertAccount(code, { verified: false }),
        await insertAccount(code, { population: 'seller' }),
        await insertAccount(code, { population: 'customer' }),
        await insertAccount(otherMarketOf(code)),
      ];
      const mine = new Set([...eligible, ...excluded].map((a) => a.accountId));

      const read = await readOnly(() => reader.activeVerifiedAdmins(market, 1000));

      expect(read.ok).toBe(true);
      const rows = read.ok ? read.value : [];
      expect(rows.filter((r) => mine.has(r.accountId))).toEqual(
        [...eligible].sort((a, b) => (a.accountId < b.accountId ? -1 : 1)),
      );
      // Ordered by id over the whole answer, and never a row of another Market.
      expect(rows.map((r) => r.accountId)).toEqual(rows.map((r) => r.accountId).sort());
      const { rows: markets } = await sql.query<{ market_id: string }>(
        'SELECT DISTINCT market_id FROM identity.accounts WHERE id = ANY($1::uuid[])',
        [rows.map((r) => r.accountId)],
      );
      expect(markets.map((m) => m.market_id)).toEqual(rows.length === 0 ? [] : [code]);
    });

    it('honours the limit in account-id order', async () => {
      await insertAccount(code);
      await insertAccount(code);
      const { rows: expected } = await sql.query<{ id: string }>(
        `SELECT id FROM identity.accounts
        WHERE market_id = $1 AND population = 'admin' AND status = 'active'
          AND email_verified_at IS NOT NULL
        ORDER BY id LIMIT 2`,
        [code],
      );

      const read = await readOnly(() => reader.activeVerifiedAdmins(market, 2));

      expect(read.ok && read.value.map((r) => r.accountId)).toEqual(expected.map((r) => r.id));
    });

    it('runs in a read-only unit without a transaction (ADR-0025)', async () => {
      await driver.during(() => readOnly(() => reader.activeVerifiedAdmins(market, 1000)));

      expect(driver.statements.length).toBeGreaterThan(0);
      for (const statement of driver.statements) {
        expect(statement.trim()).not.toMatch(/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/i);
        expect(statement.trim()).toMatch(/^SELECT/i);
      }
    });

    it('answers no reviewer while no admin has an active factor in the store', async () => {
      // Other files may give their own admins a factor in this database at the same time, so
      // only this test's account is looked at.
      const mine = await insertAccount(code);
      const reviewers = new AccountAccessReviewers({
        unitOfWork: db.unitOfWork,
        candidates: reader,
        grants: new PrismaRoleGrantReader(db.service),
        effectiveKeys: realEffectiveKeys(),
        factors: new PrismaSecondFactorRepository(db.service),
      });

      const answered = await reviewers.reviewersOf(market);
      expect(answered.filter((r) => r.accountId === mine.accountId)).toEqual([]);
    });

    it('reads the candidates, their roles and their factors in one read-only unit, with SELECTs only', async () => {
      await insertAccount(code);
      const reviewers = new AccountAccessReviewers({
        unitOfWork: db.unitOfWork,
        candidates: reader,
        grants: new PrismaRoleGrantReader(db.service),
        effectiveKeys: realEffectiveKeys(),
        factors: new PrismaSecondFactorRepository(db.service),
      });

      await driver.during(() => reviewers.reviewersOf(market));

      expect(driver.statements.some((st) => /identity"?\."?role_assignments/.test(st))).toBe(true);
      expect(driver.statements.some((st) => /identity"?\."?second_factors/.test(st))).toBe(true);
      for (const statement of driver.statements) {
        expect(statement.trim()).toMatch(/^SELECT/i);
      }
    });
  },
);
