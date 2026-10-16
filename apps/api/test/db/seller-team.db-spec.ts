import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import {
  INVITATION_REPOSITORY,
  type InvitationRepository,
} from '../../src/modules/identity/application/ports/invitation.repository';
import {
  ROLE_ASSIGNMENT_REPOSITORY,
  type RoleAssignmentRepository,
} from '../../src/modules/identity/application/ports/seller-team.repository';
import {
  SELLER_TEAM_READER,
  type SellerTeamReader,
} from '../../src/modules/identity/application/ports/seller-team-reader';
import {
  SESSION_REPOSITORY,
  type SessionRepository,
} from '../../src/modules/identity/application/ports/session.repository';
import { AssignTeamMemberRole } from '../../src/modules/identity/application/use-cases/assign-team-member-role.use-case';
import { ListSellerTeam } from '../../src/modules/identity/application/use-cases/list-seller-team.use-case';
import { RemoveTeamMember } from '../../src/modules/identity/application/use-cases/remove-team-member.use-case';
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import { openSession } from '../../src/modules/identity/domain/session';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { extendUnitTimeout, gate, holdRetriesUntil, marketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Identity slice 11 on PostgreSQL (identity design 5.3, 5.5, HF8; data design 5.1), for both
// Market fixtures, as the application role on the run database. The holder count of the last
// guard is the seller's, so each case owns a fresh seller and no other file's rows matter. Two
// owners who each demote or remove the other at once run in serializable units: exactly one
// commits, the other is retried and refused, and the shop keeps an owner. Also the removal's
// persisted membership, assignment and sessions, and the three reads (team reader, pending
// Staff invitations and their count, holders of a role in a seller).

const CREATED = '2026-10-08T00:00:00Z';
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn';
const newId = <T extends string>(): Id<T> =>
  `01990000-0000-7000-8000-${randomBytes(6).toString('hex')}` as Id<T>;

describe.each(TEST_MARKETS)('the seller team in market %s (database, slice 11)', (code) => {
  const market = marketOf(code);
  let app: NestExpressApplication;
  let sql: Client;
  let logs: jest.SpyInstance[];

  beforeAll(async () => {
    ({ app } = await createTestApp({ env: { DATABASE_URL: testDatabaseUrl() } }));
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    await app
      .get(SeedRoles)
      .execute(testCallContext(market, 'system', `db-seller-team-${randomUUID()}`), {});
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

  async function roleId(seedCode: string): Promise<Id<'Role'>> {
    const { rows } = await sql.query<{ id: string }>(
      `SELECT id FROM identity.roles WHERE market_id = $1 AND scope = 'seller' AND seed_code = $2`,
      [code, seedCode],
    );
    return rows[0]!.id as Id<'Role'>;
  }

  async function seller(state: 'approved' | 'pending' = 'approved'): Promise<Id<'Seller'>> {
    const id = newId<'Seller'>();
    await sql.query(
      `INSERT INTO identity.seller_access (seller_id, market_id, tenant_id, origin, state,
       state_changed_at, reapply_count, registered_at, version, created_at)
       VALUES ($1, $2, 'default', 'self', $3, $4, 0, $4, 1, $4)`,
      [id, code, state, CREATED],
    );
    return id;
  }

  async function member(sellerId: Id<'Seller'>, seedCode: string): Promise<Id<'Account'>> {
    const id = newId<'Account'>();
    const email = `Member.${id}@Shop.example`;
    await sql.query(
      `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
       email_normalized, display_name, status, email_verified_at, signed_up_at, version, created_at)
       VALUES ($1, $2, 'default', 'seller', $3, $4, 'Member', 'active', $5, $5, 1, $5)`,
      [id, code, email, email.toLowerCase(), CREATED],
    );
    await sql.query(
      `INSERT INTO identity.password_credentials
         (market_id, tenant_id, account_id, password_hash, changed_at)
       VALUES ($1, 'default', $2, $3, $4)`,
      [code, id, PASSWORD_HASH, CREATED],
    );
    await sql.query(
      `INSERT INTO identity.seller_memberships (id, market_id, tenant_id, account_id, seller_id,
       state, removed_at, version, created_at)
       VALUES ($1, $2, 'default', $3, $4, 'active', NULL, 1, $5)`,
      [newId(), code, id, sellerId, CREATED],
    );
    await sql.query(
      `INSERT INTO identity.role_assignments (id, market_id, tenant_id, account_id, role_id,
       assigned_by_account_id, assigned_at, version)
       VALUES ($1, $2, 'default', $3, $4, NULL, $5, 1)`,
      [newId(), code, id, await roleId(seedCode), CREATED],
    );
    return id;
  }

  const as = (accountId: Id<'Account'>, sellerId: Id<'Seller'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId,
        sessionId: newId<'Session'>(),
        sellerId,
      }),
      `db-seller-team-${randomUUID()}`,
    );

  async function sessionOf(
    accountId: Id<'Account'>,
    sellerId: Id<'Seller'>,
  ): Promise<Id<'Session'>> {
    const id = newId<'Session'>();
    await app.get<UnitOfWork>(UNIT_OF_WORK).run(market, async () => {
      await app.get<SessionRepository>(SESSION_REPOSITORY).add(
        market,
        openSession({
          id,
          marketId: market.marketId,
          accountId,
          population: 'seller',
          sellerId,
          transport: 'cookie',
          lifetime: { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 },
          now: Temporal.Now.instant(),
        }),
        new Uint8Array(randomBytes(32)),
      );
      return ok(undefined);
    });
    return id;
  }

  async function activeOwners(sellerId: Id<'Seller'>): Promise<string[]> {
    const { rows } = await sql.query<{ account_id: string }>(
      `SELECT a.account_id FROM identity.role_assignments a
       JOIN identity.seller_memberships m ON m.market_id = a.market_id
         AND m.account_id = a.account_id AND m.state = 'active'
       WHERE a.market_id = $1 AND a.role_id = $2 AND m.seller_id = $3`,
      [code, await roleId('seller-owner'), sellerId],
    );
    return rows.map((r) => r.account_id);
  }

  /** Holds each unit right after it counted the seller's holders until both have (or 5 s). */
  function bothCountFirst(): jest.SpyInstance {
    const assignments = app.get<RoleAssignmentRepository>(ROLE_ASSIGNMENT_REPOSITORY);
    const original = assignments.activeHoldersOfInSeller.bind(assignments);
    const counted = gate();
    let arrived = 0;
    return jest
      .spyOn(assignments, 'activeHoldersOfInSeller')
      .mockImplementation(async (on, role, sellerId) => {
        const holders = await original(on, role, sellerId);
        arrived += 1;
        if (arrived === 2) counted.open();
        await Promise.race([counted.opened, new Promise((resolve) => setTimeout(resolve, 10_000))]);
        return holders;
      });
  }

  /**
   * Two owners act on each other at once, both held until each has counted the holders. Exactly
   * one commits; the serializable check refuses the other's commit (40001), its retry re-reads
   * its actor in the unit and finds it demoted or removed: `access.denied`, before it counts
   * again. Without the serializable unit both commit and the shop has no owner left.
   */
  async function race(
    first: (
      sellerId: Id<'Seller'>,
      one: Id<'Account'>,
      two: Id<'Account'>,
    ) => Promise<Result<unknown, unknown>>,
    second: (
      sellerId: Id<'Seller'>,
      one: Id<'Account'>,
      two: Id<'Account'>,
    ) => Promise<Result<unknown, unknown>>,
  ) {
    const sellerId = await seller();
    const one = await member(sellerId, 'seller-owner');
    const two = await member(sellerId, 'seller-owner');
    const spy = bothCountFirst();
    const oneSettled = gate();
    const restorePause = holdRetriesUntil(app.get(UNIT_OF_WORK), oneSettled.opened);
    // The held unit may wait up to 10 s for the other one, longer than the 5 s default timeout.
    const restoreTimeout = extendUnitTimeout(app.get(UNIT_OF_WORK), 20_000);

    let results: Result<unknown, unknown>[];
    let counts: number;
    try {
      results = await Promise.all(
        [first(sellerId, one, two), second(sellerId, one, two)].map((run) =>
          run.finally(() => oneSettled.open()),
        ),
      );
      counts = spy.mock.calls.length;
    } finally {
      // Restored even when a unit throws, so the next test spies on the real repository.
      spy.mockRestore();
      restorePause();
      restoreTimeout();
    }

    expect(counts).toBe(2);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: { code: 'access.denied' } }]);
    expect(await activeOwners(sellerId)).toHaveLength(1);
  }

  it('two owners demoting each other at once: one commits, one owner remains (HF8)', async () => {
    const manager = await roleId('store-manager');
    const assign = app.get(AssignTeamMemberRole);

    await race(
      (s, one, two) => assign.execute(as(one, s), { accountId: two, roleId: manager }),
      (s, one, two) => assign.execute(as(two, s), { accountId: one, roleId: manager }),
    );
  });

  it('two owners removing each other at once: one commits, one owner remains (HF8)', async () => {
    const remove = app.get(RemoveTeamMember);

    await race(
      (s, one, two) => remove.execute(as(one, s), { accountId: two }),
      (s, one, two) => remove.execute(as(two, s), { accountId: one }),
    );
  });

  it('one owner removing the other while that one demotes it: one remains', async () => {
    const manager = await roleId('store-manager');
    const remove = app.get(RemoveTeamMember);
    const assign = app.get(AssignTeamMemberRole);

    await race(
      (s, one, two) => remove.execute(as(one, s), { accountId: two }),
      (s, one, two) => assign.execute(as(two, s), { accountId: one, roleId: manager }),
    );
  });

  it('writes the role change, its event and its audit row in one unit', async () => {
    const sellerId = await seller();
    const owner = await member(sellerId, 'seller-owner');
    const target = await member(sellerId, 'store-manager');

    await expect(
      app.get(AssignTeamMemberRole).execute(as(owner, sellerId), {
        accountId: target,
        roleId: await roleId('catalogue-stock'),
      }),
    ).resolves.toMatchObject({ ok: true, value: { code: 'role.assigned' } });

    const { rows } = await sql.query<{ role_id: string; version: number; by: string }>(
      `SELECT role_id, version, assigned_by_account_id AS by FROM identity.role_assignments
       WHERE market_id = $1 AND account_id = $2`,
      [code, target],
    );
    expect(rows).toEqual([{ role_id: await roleId('catalogue-stock'), version: 2, by: owner }]);
    const audits = await sql.query<{ n: string }>(
      `SELECT count(*) AS n FROM platform.audit_log WHERE market_id = $1
       AND action = 'identity.account-role.changed' AND target_id = $2`,
      [code, target],
    );
    expect(Number(audits.rows[0]!.n)).toBe(1);
  });

  it('removes a member: membership ended, assignment gone, sessions revoked, event and audit written', async () => {
    const sellerId = await seller();
    const owner = await member(sellerId, 'seller-owner');
    const target = await member(sellerId, 'store-manager');
    const targetSession = await sessionOf(target, sellerId);
    const ownerSession = await sessionOf(owner, sellerId);

    await expect(
      app.get(RemoveTeamMember).execute(as(owner, sellerId), { accountId: target }),
    ).resolves.toEqual({
      ok: true,
      value: { code: 'member.removed', accountId: target, revokedSessions: 1 },
    });

    const membership = await sql.query<{ state: string; removed_at: Date | null; version: number }>(
      `SELECT state, removed_at, version FROM identity.seller_memberships
       WHERE market_id = $1 AND account_id = $2`,
      [code, target],
    );
    expect(membership.rows).toEqual([
      { state: 'removed', removed_at: expect.any(Date) as Date, version: 2 },
    ]);
    const assignments = await sql.query(
      `SELECT 1 FROM identity.role_assignments WHERE market_id = $1 AND account_id = $2`,
      [code, target],
    );
    expect(assignments.rowCount).toBe(0);
    const sessions = await sql.query<{
      id: string;
      revoked_at: Date | null;
      revoked_reason: string | null;
    }>(
      `SELECT id, revoked_at, revoked_reason FROM identity.sessions
       WHERE market_id = $1 AND id = ANY($2)`,
      [code, [targetSession, ownerSession]],
    );
    const byId = new Map(sessions.rows.map((r) => [r.id, r]));
    expect(byId.get(targetSession)).toMatchObject({ revoked_reason: 'membership-removed' });
    expect(byId.get(targetSession)!.revoked_at).not.toBeNull();
    expect(byId.get(ownerSession)!.revoked_at).toBeNull();
    const events = await sql.query<{ n: string }>(
      `SELECT count(*) AS n FROM identity.outbox WHERE market_id = $1
       AND type = 'identity.seller-member-removed.v1'
       AND payload->>'accountId' = $2`,
      [code, target],
    );
    expect(Number(events.rows[0]!.n)).toBe(1);
    const audits = await sql.query<{ n: string }>(
      `SELECT count(*) AS n FROM platform.audit_log WHERE market_id = $1
       AND action = 'identity.seller-member.removed' AND target_id = $2`,
      [code, target],
    );
    expect(Number(audits.rows[0]!.n)).toBe(1);

    // The same account may be a member again later: the active-only unique index allows it.
    const again = await sql.query(
      `SELECT 1 FROM identity.seller_memberships WHERE market_id = $1 AND account_id = $2
       AND state = 'active'`,
      [code, target],
    );
    expect(again.rowCount).toBe(0);
  });

  it('refuses another seller’s member, and the unapproved seller’s owner, without writing', async () => {
    const mine = await seller();
    const theirs = await seller();
    const owner = await member(mine, 'seller-owner');
    const foreign = await member(theirs, 'store-manager');

    await expect(
      app.get(RemoveTeamMember).execute(as(owner, mine), { accountId: foreign }),
    ).resolves.toEqual({ ok: false, error: { code: 'account.unknown' } });

    const pending = await seller('pending');
    const pendingOwner = await member(pending, 'seller-owner');
    const pendingMember = await member(pending, 'store-manager');
    await expect(
      app.get(RemoveTeamMember).execute(as(pendingOwner, pending), { accountId: pendingMember }),
    ).resolves.toMatchObject({ ok: false });

    const { rows } = await sql.query<{ state: string }>(
      `SELECT state FROM identity.seller_memberships WHERE market_id = $1 AND account_id = ANY($2)`,
      [code, [foreign, pendingMember]],
    );
    expect(rows.map((r) => r.state)).toEqual(['active', 'active']);
  });

  it('reads the holders of a role in one seller, the active members, and pending Staff invitations', async () => {
    const sellerId = await seller();
    const other = await seller();
    const owner = await member(sellerId, 'seller-owner');
    const manager = await member(sellerId, 'store-manager');
    const stranger = await member(other, 'seller-owner');
    const ownerRole = await roleId('seller-owner');
    const unitOfWork = app.get<UnitOfWork>(UNIT_OF_WORK);

    const holders = await unitOfWork.run(market, async () =>
      ok(
        await app
          .get<RoleAssignmentRepository>(ROLE_ASSIGNMENT_REPOSITORY)
          .activeHoldersOfInSeller(market, ownerRole, sellerId),
      ),
    );
    expect(holders).toEqual({ ok: true, value: [owner] });

    await sql.query(
      `UPDATE identity.seller_memberships SET state = 'removed', removed_at = $3, version = 2
       WHERE market_id = $1 AND account_id = $2`,
      [code, manager, CREATED],
    );
    const team = await unitOfWork.run(market, async () =>
      ok(
        await app
          .get<SellerTeamReader>(SELLER_TEAM_READER)
          .activeMembers(market, sellerId, null, 10),
      ),
    );
    expect(team.ok && team.value.map((m) => m.accountId)).toEqual([owner]);
    expect(JSON.stringify(team)).not.toMatch(/password|hash/i);
    expect(JSON.stringify(team)).not.toContain(stranger);

    const invitationId = newId<'Invitation'>();
    await sql.query(
      `INSERT INTO identity.invitations (id, market_id, tenant_id, kind, email, email_normalized,
       display_name, role_id, seller_id, invited_by_account_id, token_hash, expires_at, state,
       decided_at, accepted_account_id, version, created_at)
       VALUES ($1, $2, 'default', 'staff', 'a@b.example', 'a@b.example', NULL, $3, $4, $5,
       NULL, NULL, 'pending', NULL, NULL, 1, $6)`,
      [invitationId, code, await roleId('store-manager'), sellerId, owner, CREATED],
    );
    const invitations = app.get<InvitationRepository>(INVITATION_REPOSITORY);
    const pending = await unitOfWork.run(market, async () =>
      ok({
        page: await invitations.pendingStaffInvitations(market, sellerId, null, 10),
        count: await invitations.countPendingStaff(market, sellerId),
        elsewhere: await invitations.countPendingStaff(market, other),
      }),
    );
    expect(pending.ok && pending.value.page.map((i) => i.id)).toEqual([invitationId]);
    expect(pending.ok && pending.value.count).toBe(1);
    expect(pending.ok && pending.value.elsewhere).toBe(0);
  });

  it('lists the team through the real gate and ports, for the owner of the seller only', async () => {
    const sellerId = await seller();
    const owner = await member(sellerId, 'seller-owner');
    const manager = await member(sellerId, 'store-manager');
    const list = app.get(ListSellerTeam);

    const page = await list.execute(as(owner, sellerId), { limit: 10 });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.items.map((i) => (i.type === 'account' ? i.accountId : null)).sort()).toEqual(
      [owner, manager].sort(),
    );
    expect(page.value.next).toBeNull();
  });
});
