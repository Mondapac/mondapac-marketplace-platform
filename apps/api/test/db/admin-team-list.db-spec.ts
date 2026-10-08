import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import {
  ListAdminTeam,
  type AdminTeamAccountRow,
  type AdminTeamInvitationRow,
  type AdminTeamRow,
} from '../../src/modules/identity/application/use-cases/list-admin-team.use-case';
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import { PrismaAdminAccountReader } from '../../src/modules/identity/infrastructure/admin-team/prisma-admin-account-reader';
import { PrismaInvitationRepository } from '../../src/modules/identity/infrastructure/invitations/prisma-invitation.repository';
import { PrismaSecondFactorRepository } from '../../src/modules/identity/infrastructure/second-factor/prisma-second-factor.repository';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  recordDriverStatements,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Identity slice 8c on PostgreSQL (identity design 5.3, 8.6 row 6), for both Market fixtures, as
// the application role on the run database: the admin team list through the real gate, use case
// and Prisma ports, in read-only units with no transaction (ADR-0025), and its three reads
// (admin accounts, pending admin invitations, which accounts have a factor). Other files add
// admins to the same Markets meanwhile, so each case pages through the whole list and looks at
// its own rows only; no hint asserted here depends on another file's rows.

const CREATED = '2026-10-08T00:00:00Z';
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn';
const ID_PREFIX = '01990000-0000-7000-8000-';
const newId = <T extends string>(): Id<T> =>
  `${ID_PREFIX}${randomBytes(6).toString('hex')}` as Id<T>;

describe.each(TEST_MARKETS)('the admin team list in market %s (database, slice 8c)', (code) => {
  const market = marketOf(code);
  let app: NestExpressApplication;
  let sql: Client;
  let db: Persistence;
  let driver: ReturnType<typeof recordDriverStatements>;
  let logs: jest.SpyInstance[];

  beforeAll(async () => {
    ({ app } = await createTestApp({ env: { DATABASE_URL: testDatabaseUrl() } }));
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    db = createPersistence();
    driver = recordDriverStatements();
    // Both Markets: a case puts an admin and an invitation in the other one.
    for (const each of [market, marketOf(otherMarketOf(code))]) {
      await app
        .get(SeedRoles)
        .execute(testCallContext(each, 'system', `db-admin-list-${randomUUID()}`), {});
    }
  });
  afterAll(async () => {
    driver.restore();
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

  async function roleId(seedCode: string, marketCode: string = code): Promise<Id<'Role'>> {
    const { rows } = await sql.query<{ id: string }>(
      `SELECT id FROM identity.roles WHERE market_id = $1 AND scope = 'platform' AND seed_code = $2`,
      [marketCode, seedCode],
    );
    return rows[0]!.id as Id<'Role'>;
  }

  async function account(
    population: 'admin' | 'customer',
    marketCode: string = code,
    status: 'active' | 'disabled' = 'active',
  ): Promise<Id<'Account'>> {
    const id = newId<'Account'>();
    const email = `Person.${id}@Team.example`;
    await sql.query(
      `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
       email_normalized, display_name, status, email_verified_at, signed_up_at, version, created_at)
       VALUES ($1, $2, 'default', $3, $4, $5, $6, $7, $8, $8, 1, $8)`,
      [
        id,
        marketCode,
        population,
        email,
        email.toLowerCase(),
        population === 'admin' ? 'Team Member' : null,
        status,
        CREATED,
      ],
    );
    await sql.query(
      `INSERT INTO identity.password_credentials
         (market_id, tenant_id, account_id, password_hash, changed_at)
       VALUES ($1, 'default', $2, $3, $4)`,
      [marketCode, id, PASSWORD_HASH, CREATED],
    );
    return id;
  }

  async function admin(
    seedCode: string,
    options: { marketCode?: string; status?: 'active' | 'disabled' } = {},
  ): Promise<Id<'Account'>> {
    const marketCode = options.marketCode ?? code;
    const id = await account('admin', marketCode, options.status);
    await sql.query(
      `INSERT INTO identity.role_assignments (id, market_id, tenant_id, account_id, role_id,
       assigned_by_account_id, assigned_at, version)
       VALUES ($1, $2, 'default', $3, $4, NULL, $5, 1)`,
      [newId(), marketCode, id, await roleId(seedCode, marketCode), CREATED],
    );
    return id;
  }

  async function invitation(
    row: {
      invitedBy?: Id<'Account'> | null;
      state?: 'pending' | 'revoked';
      marketCode?: string;
      dispatched?: boolean;
    } = {},
  ): Promise<Id<'Invitation'>> {
    const id = newId<'Invitation'>();
    const marketCode = row.marketCode ?? code;
    const pending = (row.state ?? 'pending') === 'pending';
    const email = pending ? `Invitee.${id}@Team.example` : null;
    const dispatched = row.dispatched ?? true;
    await sql.query(
      `INSERT INTO identity.invitations (id, market_id, tenant_id, kind, email, email_normalized,
       display_name, role_id, seller_id, invited_by_account_id, token_hash, expires_at, state,
       decided_at, accepted_account_id, version, created_at)
       VALUES ($1, $2, 'default', 'admin', $3, $4, NULL, $5, NULL, $6, $7, $8, $9, $10, NULL, 2,
       $11)`,
      [
        id,
        marketCode,
        email,
        email?.toLowerCase() ?? null,
        await roleId('viewer', marketCode),
        row.invitedBy === undefined ? null : row.invitedBy,
        dispatched ? randomBytes(32) : null,
        // The use case reads the real clock: created now, its mail valid for another hour.
        dispatched ? new Date(Date.now() + 3_600_000).toISOString() : null,
        pending ? 'pending' : 'revoked',
        pending ? null : CREATED,
        new Date().toISOString(),
      ],
    );
    return id;
  }

  async function pendingFactor(accountId: Id<'Account'>): Promise<void> {
    await sql.query(
      `INSERT INTO identity.second_factors (id, market_id, tenant_id, account_id, state,
       secret_ciphertext, pending_secret_ciphertext, last_accepted_step, activated_at, locked_at,
       created_at, version)
       VALUES ($1, $2, 'default', $3, 'pending', 'sealed', NULL, NULL, NULL, NULL, $4, 1)`,
      [newId(), code, accountId, CREATED],
    );
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
      `db-admin-list-${randomUUID()}`,
    );

  /**
   * Every row of the list in this file's id range, page by page. Other files of the run insert
   * rows into the same Markets, some with non-v7 ids that the API never mints and `after`
   * refuses; this file's ids all lie in the range below, so paging starts and stops there.
   */
  async function everyRow(actor: Id<'Account'>, limit = 100): Promise<AdminTeamRow[]> {
    const list = app.get(ListAdminTeam);
    const rows: AdminTeamRow[] = [];
    let after: string | null = `${ID_PREFIX}000000000000`;
    for (let pages = 0; pages < 1000; pages += 1) {
      const result = await list.execute(as(actor), { after, limit });
      if (!result.ok) throw new Error(`listed: ${result.error.code}`);
      rows.push(...result.value.items);
      after = result.value.next;
      if (after === null || after > `${ID_PREFIX}ffffffffffff`) break;
    }
    return rows;
  }
  const rowId = (row: AdminTeamRow) => (row.type === 'account' ? row.accountId : row.invitationId);

  it('lists this Market’s admins and pending admin invitations by id, with the hints of the commands', async () => {
    const root = await admin('platform-administrator');
    const root2 = await admin('platform-administrator');
    const viewer = await admin('viewer');
    const off = await admin('finance', { status: 'disabled' });
    const customer = await account('customer');
    const elsewhere = await admin('viewer', { marketCode: otherMarketOf(code) });
    const byRoot = await invitation({ invitedBy: root });
    const firstAdmin = await invitation({ invitedBy: null, dispatched: false });
    const revoked = await invitation({ state: 'revoked', invitedBy: root });
    const otherMarket = await invitation({ invitedBy: null, marketCode: otherMarketOf(code) });
    await pendingFactor(root2);

    // Pages of 2 rows, so this file's rows cross page boundaries.
    const rows = await everyRow(root, 2);

    const ids = rows.map(rowId);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    const mine = [root, root2, viewer, off, byRoot, firstAdmin] as string[];
    expect(ids.filter((id) => mine.includes(id))).toEqual([...mine].sort());
    for (const absent of [customer, elsewhere, revoked, otherMarket]) {
      expect(ids).not.toContain(absent);
    }
    const accountRow = (id: string) => rows.find((row) => rowId(row) === id) as AdminTeamAccountRow;
    const invitationRow = (id: string) =>
      rows.find((row) => rowId(row) === id) as AdminTeamInvitationRow;
    const no = (c: string) => ({ allowed: false, code: c });
    const yes = { allowed: true, code: null };

    expect(accountRow(root)).toMatchObject({
      self: true,
      status: 'active',
      displayName: 'Team Member',
      role: { roleId: await roleId('platform-administrator'), kind: 'system' },
      actions: { disable: no('member.self') },
    });
    // A pending factor counts, as for the reset command (`findByAccount`).
    expect(accountRow(root2).actions).toEqual({
      changeRole: yes,
      disable: yes,
      enable: no('account.already-active'),
      resetSecondFactor: yes,
    });
    expect(accountRow(viewer).actions.resetSecondFactor).toEqual(no('second-factor.none'));
    expect(accountRow(off)).toMatchObject({
      status: 'disabled',
      actions: { disable: no('account.already-disabled'), enable: yes },
    });
    expect(invitationRow(byRoot)).toMatchObject({
      invitedByAccountId: root,
      status: 'pending',
      actions: { resend: yes, revoke: yes },
    });
    expect(invitationRow(firstAdmin)).toMatchObject({
      invitedByAccountId: null,
      expiresAt: null,
      actions: { resend: no('invitation.rejected'), revoke: yes },
    });

    // A view-only admin: every action access.denied.
    const asViewer = (await everyRow(viewer)).filter((row) => mine.includes(rowId(row)));
    for (const row of asViewer) {
      for (const hint of Object.values(row.actions)) {
        expect(hint).toEqual(no('access.denied'));
      }
    }
  });

  it('runs the gate and the list in read-only units: SELECTs only, no transaction (ADR-0025)', async () => {
    const root = await admin('platform-administrator');
    await invitation({ invitedBy: root });

    const result = await driver.during(() =>
      app.get(ListAdminTeam).execute(as(root), { limit: 100 }),
    );

    expect(result.ok).toBe(true);
    expect(driver.statements.length).toBeGreaterThan(0);
    for (const statement of driver.statements) {
      expect(statement.trim()).not.toMatch(/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/i);
      expect(statement.trim()).toMatch(/^SELECT/i);
    }
    // No secret column is read by the list: no factor secret, recovery code or token hash.
    expect(driver.statements.join('\n')).not.toMatch(/secret_ciphertext|code_hash|token_hash/);
  });

  it('reads pending admin invitations and factors by the Market, after an id, by id', async () => {
    const invitations = new PrismaInvitationRepository(db.service);
    const factors = new PrismaSecondFactorRepository(db.service);
    const accounts = new PrismaAdminAccountReader(db.service);
    const first = await invitation();
    const second = await invitation();
    const withFactor = await admin('viewer');
    const without = await admin('viewer');
    await pendingFactor(withFactor);
    const readOnly = <T>(work: () => Promise<T>) =>
      db.unitOfWork.run(market, async () => ok(await work()), { readOnly: true });

    const read = await readOnly(async () => ({
      all: await invitations.pendingAdminInvitations(market, null, 100000),
      after: await invitations.pendingAdminInvitations(market, first, 100000),
      factors: await factors.presentAmong(market, [withFactor, without]),
      admins: await accounts.adminAccounts(market, null, 100000),
    }));

    if (!read.ok) throw new Error('read failed');
    const allIds = read.value.all.map((i) => i.id as string);
    expect(allIds).toEqual([...allIds].sort());
    expect(allIds).toEqual(expect.arrayContaining([first, second]));
    const { rows: markets } = await sql.query<{ market_id: string }>(
      'SELECT DISTINCT market_id FROM identity.invitations WHERE id = ANY($1::uuid[])',
      [allIds],
    );
    expect(markets.map((m) => m.market_id)).toEqual([code]);
    expect(read.value.after.every((i) => i.id > first)).toBe(true);
    // A summary: no token hash (Hassan L1 on PR #196).
    expect(Object.keys(read.value.all[0]!).sort()).toEqual(
      ['createdAt', 'email', 'expiresAt', 'id', 'invitedByAccountId', 'roleId', 'state'].sort(),
    );
    expect([...read.value.factors]).toEqual([withFactor]);
    const admins = read.value.admins.map((a) => a.accountId as string);
    expect(admins).toEqual([...admins].sort());
    expect(admins).toEqual(expect.arrayContaining([withFactor, without]));
    expect(Object.keys(read.value.admins[0]!).sort()).toEqual(
      ['accountId', 'displayName', 'email', 'status'].sort(),
    );
  });
});
