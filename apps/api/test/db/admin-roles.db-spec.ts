import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import {
  ROLE_ASSIGNMENT_REPOSITORY,
  ROLE_REPOSITORY,
  type RoleAssignmentRepository,
  type RoleRepository,
} from '../../src/modules/identity/application/ports/seller-team.repository';
import { AssignAdminRole } from '../../src/modules/identity/application/use-cases/assign-admin-role.use-case';
import { DisableAdminAccount } from '../../src/modules/identity/application/use-cases/disable-admin-account.use-case';
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { gate, marketOf } from './persistence-support';
import { adminTeamTestDatabaseUrl } from './test-database';

// Identity slices 8a-2 and 8b on PostgreSQL (identity design 5.5, HF8; data design 5.1), for
// both Market fixtures, as the application role on a copy of the run database of this file
// alone (global-setup.ts): the count of active Platform Administrators is the Market's, so no
// other file's admins may live there. Two concurrent changes that would each leave one holder
// run in serializable units: exactly one commits, the other is retried and then refused, and the
// Market keeps one administrator who can sign in. Also the assignment's version-guarded write
// and the holder count's filter (active and verified only).

const CREATED = '2026-10-08T00:00:00Z';
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn';
const newId = <T extends string>(): Id<T> =>
  `01990000-0000-7000-8000-${randomBytes(6).toString('hex')}` as Id<T>;

describe.each(TEST_MARKETS)('admin roles and statuses in market %s (database, HF8)', (code) => {
  const market = marketOf(code);
  let app: NestExpressApplication;
  let sql: Client;
  let logs: jest.SpyInstance[];

  beforeAll(async () => {
    ({ app } = await createTestApp({ env: { DATABASE_URL: adminTeamTestDatabaseUrl() } }));
    sql = new Client({ connectionString: adminTeamTestDatabaseUrl() });
    await sql.connect();
    await app
      .get(SeedRoles)
      .execute(testCallContext(market, 'system', `db-admin-team-${randomUUID()}`), {});
  });
  afterAll(async () => {
    await sql.end();
    await app.close();
  });
  beforeEach(async () => {
    logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    // Each case starts from a Market without an active admin: earlier cases' admins are disabled.
    await sql.query(
      `UPDATE identity.accounts SET status = 'disabled', version = version + 1
       WHERE market_id = $1 AND population = 'admin' AND status = 'active'`,
      [code],
    );
  });
  afterEach(() => logs.forEach((spy) => spy.mockRestore()));

  async function roleId(seedCode: string): Promise<Id<'Role'>> {
    const { rows } = await sql.query<{ id: string }>(
      `SELECT id FROM identity.roles WHERE market_id = $1 AND scope = 'platform' AND seed_code = $2`,
      [code, seedCode],
    );
    return rows[0]!.id as Id<'Role'>;
  }

  async function admin(seedCode: string, verified = true): Promise<Id<'Account'>> {
    const id = newId<'Account'>();
    const email = `Admin.${id}@Admin.example`;
    await sql.query(
      `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
       email_normalized, display_name, status, email_verified_at, signed_up_at, version, created_at)
       VALUES ($1, $2, 'default', 'admin', $3, $4, 'Admin', 'active', $5, $6, 1, $6)`,
      [id, code, email, email.toLowerCase(), verified ? CREATED : null, CREATED],
    );
    await sql.query(
      `INSERT INTO identity.password_credentials
         (market_id, tenant_id, account_id, password_hash, changed_at)
       VALUES ($1, 'default', $2, $3, $4)`,
      [code, id, PASSWORD_HASH, CREATED],
    );
    await sql.query(
      `INSERT INTO identity.role_assignments (id, market_id, tenant_id, account_id, role_id,
       assigned_by_account_id, assigned_at, version)
       VALUES ($1, $2, 'default', $3, $4, NULL, $5, 1)`,
      [newId(), code, id, await roleId(seedCode), CREATED],
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
      `db-admin-team-${randomUUID()}`,
    );

  async function activeAdministrators(): Promise<string[]> {
    const { rows } = await sql.query<{ account_id: string }>(
      `SELECT a.account_id FROM identity.role_assignments a
       JOIN identity.accounts c ON c.market_id = a.market_id AND c.id = a.account_id
       WHERE a.market_id = $1 AND a.role_id = $2 AND c.status = 'active'
         AND c.email_verified_at IS NOT NULL`,
      [code, await roleId('platform-administrator')],
    );
    return rows.map((r) => r.account_id);
  }

  /**
   * Holds each unit right after it has counted the holders until both have counted (or 5 s
   * passed), so the two units overlap: each reads the other's row before either writes. A
   * retried unit passes at once. Without the serializable unit both changes commit.
   */
  function bothCountFirst(): jest.SpyInstance {
    const assignments = app.get<RoleAssignmentRepository>(ROLE_ASSIGNMENT_REPOSITORY);
    const original = assignments.activeHoldersOf.bind(assignments);
    const counted = gate();
    let arrived = 0;
    return jest.spyOn(assignments, 'activeHoldersOf').mockImplementation(async (on, role) => {
      const holders = await original(on, role);
      arrived += 1;
      if (arrived === 2) counted.open();
      await Promise.race([counted.opened, new Promise((resolve) => setTimeout(resolve, 5000))]);
      return holders;
    });
  }

  it('two administrators disabling each other at once: one commits, the other is refused (HF8)', async () => {
    const one = await admin('platform-administrator');
    const two = await admin('platform-administrator');
    const disable = app.get(DisableAdminAccount);
    const spy = bothCountFirst();

    const results = await Promise.all([
      disable.execute(as(one), { accountId: two }),
      disable.execute(as(two), { accountId: one }),
    ]);
    const counts = spy.mock.calls.length;
    spy.mockRestore();

    // Both counted before either wrote; the serializable check refused one commit, whose retry
    // counted again and found the other administrator disabled.
    expect(counts).toBe(3);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, error: { code: 'member.last-holder' } },
    ]);
    expect(await activeAdministrators()).toHaveLength(1);
  });

  it('two administrators demoting each other at once: one commits, one administrator remains (HF8)', async () => {
    const one = await admin('platform-administrator');
    const two = await admin('platform-administrator');
    const viewer = await roleId('viewer');
    const assign = app.get(AssignAdminRole);
    const spy = bothCountFirst();

    const results = await Promise.all([
      assign.execute(as(one), { accountId: two, roleId: viewer }),
      assign.execute(as(two), { accountId: one, roleId: viewer }),
    ]);
    const counts = spy.mock.calls.length;
    spy.mockRestore();
    // Both counted before either wrote; the retried loser stops at R3 or at its own count.
    expect(counts).toBeGreaterThanOrEqual(2);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    // Retried after the other committed, the loser no longer holds the system role (R3) or, if
    // it read before the commit, finds itself the last holder: refused either way.
    const refused = results.find((r) => !r.ok)!;
    expect(['member.last-holder', 'member.outranks-actor']).toContain(
      (refused as { error: { code: string } }).error.code,
    );
    expect(await activeAdministrators()).toHaveLength(1);
  });

  it('writes the role change, its event and its audit row in one unit', async () => {
    const root = await admin('platform-administrator');
    const target = await admin('viewer');

    await expect(
      app
        .get(AssignAdminRole)
        .execute(as(root), { accountId: target, roleId: await roleId('operations-support') }),
    ).resolves.toMatchObject({ ok: true, value: { code: 'role.assigned' } });

    const { rows } = await sql.query<{ role_id: string; version: number; by: string }>(
      `SELECT role_id, version, assigned_by_account_id AS by FROM identity.role_assignments
       WHERE market_id = $1 AND account_id = $2`,
      [code, target],
    );
    expect(rows).toEqual([{ role_id: await roleId('operations-support'), version: 2, by: root }]);
    const events = await sql.query<{ n: string }>(
      `SELECT count(*) AS n FROM identity.outbox WHERE market_id = $1
       AND type = 'identity.account-role-changed.v1' AND aggregate_id = $2`,
      [code, await assignmentIdOf(target)],
    );
    expect(Number(events.rows[0]!.n)).toBe(1);
    const audits = await sql.query<{ n: string }>(
      `SELECT count(*) AS n FROM platform.audit_log WHERE market_id = $1
       AND action = 'identity.account-role.changed' AND target_id = $2`,
      [code, target],
    );
    expect(Number(audits.rows[0]!.n)).toBe(1);
  });

  it('counts only active, verified holders, and refuses a stale assignment write', async () => {
    const root = await admin('platform-administrator');
    await admin('platform-administrator', false);
    const assignments = app.get<RoleAssignmentRepository>(ROLE_ASSIGNMENT_REPOSITORY);
    const unitOfWork = app.get<UnitOfWork>(UNIT_OF_WORK);
    const administrator = await roleId('platform-administrator');

    const holders = await unitOfWork.run(market, async () =>
      ok(await assignments.activeHoldersOf(market, administrator)),
    );
    expect(holders).toEqual({ ok: true, value: [root] });

    const viewerId = await roleId('viewer');
    const read = await unitOfWork.run(market, async () =>
      ok({
        assignment: await assignments.findByAccount(market, root),
        viewer: await app.get<RoleRepository>(ROLE_REPOSITORY).findById(market, viewerId),
      }),
    );
    if (!read.ok || read.value.assignment === null || read.value.viewer === null) {
      throw new Error('fixture missing');
    }
    const stale = read.value.assignment;
    await sql.query(
      `UPDATE identity.role_assignments SET version = version + 1
       WHERE market_id = $1 AND account_id = $2`,
      [code, root],
    );
    stale.reassign({
      account: { id: root, marketId: market.marketId, population: 'admin' },
      role: read.value.viewer,
      assignedBy: root,
      now: stale.state.assignedAt,
    });
    await expect(
      unitOfWork.run(market, async () => {
        await assignments.save(market, stale);
        return ok(undefined);
      }),
    ).rejects.toBeInstanceOf(StaleAggregateError);
  });

  async function assignmentIdOf(accountId: Id<'Account'>): Promise<string> {
    const { rows } = await sql.query<{ id: string }>(
      `SELECT id FROM identity.role_assignments WHERE market_id = $1 AND account_id = $2`,
      [code, accountId],
    );
    return rows[0]!.id;
  }
});
