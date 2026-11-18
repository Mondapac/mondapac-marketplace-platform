import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import {
  SESSION_REPOSITORY,
  type SessionRepository,
} from '../../src/modules/identity/application/ports/session.repository';
import { AssignAdminRole } from '../../src/modules/identity/application/use-cases/assign-admin-role.use-case';
import { CreatePlatformRole } from '../../src/modules/identity/application/use-cases/create-platform-role.use-case';
import { DisableAdminAccount } from '../../src/modules/identity/application/use-cases/disable-admin-account.use-case';
import { EditPlatformRole } from '../../src/modules/identity/application/use-cases/edit-platform-role.use-case';
import { EnableAdminAccount } from '../../src/modules/identity/application/use-cases/enable-admin-account.use-case';
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import { openSession } from '../../src/modules/identity/domain/session';
import { ApproveSystemRequest } from '../../src/modules/system-requests/application/use-cases/approve-system-request.use-case';
import { ViewSystemRequest } from '../../src/modules/system-requests/application/use-cases/view-system-request.use-case';
import { RejectSystemRequest } from '../../src/modules/system-requests/application/use-cases/reject-system-request.use-case';
import { WithdrawSystemRequest } from '../../src/modules/system-requests/application/use-cases/withdraw-system-request.use-case';
import { STEP_UP_CONSUMER } from '../../src/platform/authz';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { withRoleLimit } from '../support/role-limits';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Admin Inbox › System requests, area people, on PostgreSQL with the real recorder through the
// application graph, in both Market fixtures (people is reviewed by default, at high risk): a
// change without a note leaves nothing behind (its unit rolls back); a change with one opens its
// request in the same unit; a reviewer's reject runs identity's reverter in the decision's
// serializable unit and restores what narrows access, audited with the request id, while a
// revert that would widen access is refused and the request stays open. A disable opens
// nothing. A reviewer never decides a change about themselves (their own account, or a role they
// hold now): approve and reject answer `system-requests.own-subject`. The reviewer's step-up proof is stubbed (its spend is system-requests' own test).
// Accounts and roles are new per test, so no other spec's rows are met.

const CREATED = '2026-11-15T00:00:00Z';
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn';
const newId = <T extends string>(): Id<T> =>
  `01990000-0000-7000-8000-${randomBytes(6).toString('hex')}` as Id<T>;

describe.each(TEST_MARKETS)('people reviews in market %s (database, System requests)', (code) => {
  const market = marketOf(code);
  let app: NestExpressApplication;
  let sql: Client;
  let logs: jest.SpyInstance[];

  beforeAll(async () => {
    ({ app } = await createTestApp({
      env: { DATABASE_URL: testDatabaseUrl() },
      override: (builder) =>
        withRoleLimit(builder, 1000)
          .overrideProvider(STEP_UP_CONSUMER)
          .useValue({
            consume: (context: CallContext) =>
              Promise.resolve(
                ok({
                  sessionId: (context.actor as { sessionId: Id<'Session'> }).sessionId,
                  verifiedAt: Temporal.Now.instant(),
                }),
              ),
          }),
    }));
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    await app
      .get(SeedRoles)
      .execute(testCallContext(market, 'system', `db-people-${randomUUID()}`), {});
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

  const as = (accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId,
        sessionId: newId<'Session'>(),
        sellerId: null,
      }),
      `db-people-${randomUUID()}`,
    );

  async function seededRole(seedCode: string): Promise<Id<'Role'>> {
    const { rows } = await sql.query<{ id: string }>(
      `SELECT id FROM identity.roles WHERE market_id = $1 AND scope = 'platform' AND seed_code = $2`,
      [code, seedCode],
    );
    return rows[0]!.id as Id<'Role'>;
  }

  async function admin(roleId: Id<'Role'>, status = 'active'): Promise<Id<'Account'>> {
    const id = newId<'Account'>();
    const email = `People.${id}@Review.example`;
    await sql.query(
      `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
       email_normalized, display_name, status, email_verified_at, signed_up_at, version, created_at)
       VALUES ($1, $2, 'default', 'admin', $3, $4, 'People', $6, $5, $5, 1, $5)`,
      [id, code, email, email.toLowerCase(), CREATED, status],
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
      [newId(), code, id, roleId, CREATED],
    );
    return id;
  }

  async function customRole(root: Id<'Account'>, keys: string[]): Promise<Id<'Role'>> {
    const made = await app.get(CreatePlatformRole).execute(as(root), {
      name: `People ${randomUUID().slice(0, 8)}`,
      permissionKeys: keys,
    });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    return made.value.roleId;
  }

  const roleIdOf = async (accountId: Id<'Account'>) =>
    (
      await sql.query<{ role_id: string }>(
        'SELECT role_id FROM identity.role_assignments WHERE market_id = $1 AND account_id = $2',
        [code, accountId],
      )
    ).rows[0]!.role_id;
  const keysOf = async (roleId: Id<'Role'>) =>
    (
      await sql.query<{ permission_key: string }>(
        `SELECT permission_key FROM identity.role_permissions WHERE market_id = $1 AND role_id = $2
         ORDER BY permission_key`,
        [code, roleId],
      )
    ).rows.map((row) => row.permission_key);
  const statusOf = async (accountId: Id<'Account'>) =>
    (
      await sql.query<{ status: string }>(
        'SELECT status FROM identity.accounts WHERE market_id = $1 AND id = $2',
        [code, accountId],
      )
    ).rows[0]!.status;
  const requestsOf = async (subjectRef: string) =>
    (
      await sql.query<{
        id: Id<'SystemRequest'>;
        status: string;
        risk: string;
        area: string;
        subject_kind: string;
        before: unknown;
        after: unknown;
        note: string;
      }>(
        `SELECT id, status, risk, area, subject_kind, before, after, note
         FROM system_requests.requests WHERE market_id = $1 AND subject_ref = $2 ORDER BY number`,
        [code, subjectRef],
      )
    ).rows;
  const auditOf = async (action: string, targetId: string) =>
    (
      await sql.query<{ after: { requestId?: string } }>(
        `SELECT after FROM platform.audit_log WHERE market_id = $1 AND action = $2 AND target_id = $3`,
        [code, action, targetId],
      )
    ).rows;
  const outboxTypesOf = async (aggregateId: string) =>
    (
      await sql.query<{ type: string }>(
        'SELECT type FROM identity.outbox WHERE market_id = $1 AND aggregate_id = $2',
        [code, aggregateId],
      )
    ).rows.map((row) => row.type);
  const roleVersionOf = async (roleId: Id<'Role'>) =>
    (
      await sql.query<{ version: number }>(
        'SELECT version FROM identity.roles WHERE market_id = $1 AND id = $2',
        [code, roleId],
      )
    ).rows[0]!.version;
  /** A live admin session of `accountId`, through the real store. */
  const sessionOf = (accountId: Id<'Account'>) =>
    app.get<UnitOfWork>(UNIT_OF_WORK).run(market, async () => {
      await app.get<SessionRepository>(SESSION_REPOSITORY).add(
        market,
        openSession({
          id: newId<'Session'>(),
          marketId: market.marketId,
          accountId,
          population: 'admin',
          transport: 'cookie',
          lifetime: { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 },
          now: Temporal.Now.instant(),
        }),
        new Uint8Array(randomBytes(32)),
      );
      return ok(undefined);
    });
  const revokedReasonsOf = async (accountId: Id<'Account'>) =>
    (
      await sql.query<{ revoked_reason: string | null }>(
        'SELECT revoked_reason FROM identity.sessions WHERE market_id = $1 AND account_id = $2',
        [code, accountId],
      )
    ).rows.map((row) => row.revoked_reason);
  const reject = (reviewer: Id<'Account'>, requestId: Id<'SystemRequest'>) =>
    app.get(RejectSystemRequest).execute(as(reviewer), { requestId, reason: 'Not agreed' });

  it('keeps nothing of a role change without a note, and reverts a reviewed one on reject', async () => {
    const pa = await seededRole('platform-administrator');
    const root = await admin(pa);
    const checker = await admin(pa);
    const narrow = await customRole(root, ['identity.admin-account.view']);
    const wide = await customRole(root, [
      'identity.admin-account.view',
      'identity.platform-role.view',
    ]);
    const member = await admin(narrow);

    const refused = await app
      .get(AssignAdminRole)
      .execute(as(root), { accountId: member, roleId: wide });
    expect(refused).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    expect(await roleIdOf(member)).toBe(narrow);
    expect(await requestsOf(member)).toEqual([]);
    expect(await auditOf('identity.account-role.changed', member)).toEqual([]);

    const saved = await app
      .get(AssignAdminRole)
      .execute(as(root), { accountId: member, roleId: wide, note: 'Needs the role list' });
    if (!saved.ok || saved.value.request === null) throw new Error('no request opened');
    expect(await roleIdOf(member)).toBe(wide);
    const [opened] = await requestsOf(member);
    expect(opened).toMatchObject({
      id: saved.value.request.id,
      status: 'open',
      area: 'people',
      risk: 'high',
      subject_kind: 'identity.admin-roles',
      before: { roleIds: [narrow] },
      after: { roleIds: [wide] },
      note: 'Needs the role list',
    });

    expect(await reject(checker, opened!.id)).toMatchObject({
      ok: true,
      value: { status: 'reverted', decision: 'rejected' },
    });
    expect(await roleIdOf(member)).toBe(narrow);
    expect(await auditOf('identity.account-role.reverted', member)).toMatchObject([
      { after: { roleId: narrow, requestId: opened!.id } },
    ]);
  });

  it('reverts a role edit that added a key; refuses one that would add a key back', async () => {
    const pa = await seededRole('platform-administrator');
    const root = await admin(pa);
    const checker = await admin(pa);
    const role = await customRole(root, ['identity.admin-account.view']);
    const edit = app.get(EditPlatformRole);
    const name = `Edited ${randomUUID().slice(0, 8)}`;

    const added = await edit.execute(as(root), {
      roleId: role,
      expectedVersion: 1,
      name,
      permissionKeys: ['identity.admin-account.view', 'identity.platform-role.view'],
      note: 'Add the role list',
    });
    if (!added.ok || added.value.request === null) throw new Error('no request opened');
    expect(await reject(checker, added.value.request.id)).toMatchObject({ ok: true });
    expect(await keysOf(role)).toEqual(['identity.admin-account.view']);
    expect(await auditOf('identity.role.reverted', role)).toMatchObject([
      {
        after: {
          removedKeys: ['identity.platform-role.view'],
          renamed: true,
          requestId: added.value.request.id,
        },
      },
    ]);

    const removed = await edit.execute(as(root), {
      roleId: role,
      expectedVersion: 3,
      name,
      permissionKeys: [],
      note: 'Nothing for now',
    });
    if (!removed.ok || removed.value.request === null) throw new Error('no request opened');
    expect(await reject(checker, removed.value.request.id)).toEqual({
      ok: false,
      error: { code: 'system-requests.revert-not-permitted' },
    });
    expect(await keysOf(role)).toEqual([]);
    expect((await requestsOf(role)).map((r) => r.status)).toEqual(['reverted', 'open']);
  });

  it('disables again an admin whose enabling is rejected, ending its sessions; a disable opens nothing', async () => {
    const pa = await seededRole('platform-administrator');
    const root = await admin(pa);
    const checker = await admin(pa);
    const target = await admin(await seededRole('viewer'));

    const disabled = await app.get(DisableAdminAccount).execute(as(root), { accountId: target });
    expect(disabled).toMatchObject({
      ok: true,
      value: { code: 'account.disabled', request: null },
    });
    expect(await requestsOf(target)).toEqual([]);

    const enabled = await app
      .get(EnableAdminAccount)
      .execute(as(root), { accountId: target, note: 'Back from leave' });
    if (!enabled.ok || enabled.value.request === null) throw new Error('no request opened');
    await app.get<UnitOfWork>(UNIT_OF_WORK).run(market, async () => {
      await app.get<SessionRepository>(SESSION_REPOSITORY).add(
        market,
        openSession({
          id: newId<'Session'>(),
          marketId: market.marketId,
          accountId: target,
          population: 'admin',
          transport: 'cookie',
          lifetime: { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 },
          now: Temporal.Now.instant(),
        }),
        new Uint8Array(randomBytes(32)),
      );
      return ok(undefined);
    });

    expect(await reject(checker, enabled.value.request.id)).toMatchObject({ ok: true });
    expect(await statusOf(target)).toBe('disabled');
    const sessions = await sql.query<{ revoked_reason: string | null }>(
      'SELECT revoked_reason FROM identity.sessions WHERE market_id = $1 AND account_id = $2',
      [code, target],
    );
    expect(sessions.rows.map((row) => row.revoked_reason)).toEqual(['account-disabled']);
    expect(await auditOf('identity.account-status.reverted', target)).toMatchObject([
      {
        after: { status: 'disabled', requestId: enabled.value.request.id },
      },
    ]);
  });
  it('refuses a reviewer deciding a change about themselves; another reviewer decides it', async () => {
    const pa = await seededRole('platform-administrator');
    const root = await admin(pa);
    const checker = await admin(pa);
    const reviewKeys = [
      'system-requests.request.view',
      'system-requests.people.review',
      'identity.admin-account.view',
    ];
    const reviewers = await customRole(root, reviewKeys);
    const holder = await admin(reviewers);
    const approve = (reviewer: Id<'Account'>, requestId: Id<'SystemRequest'>) =>
      app.get(ApproveSystemRequest).execute(as(reviewer), { requestId });
    const ownSubject = { ok: false, error: { code: 'system-requests.own-subject' } };

    // A role edit of the role the reviewer holds now (identity.platform-role).
    const edited = await app.get(EditPlatformRole).execute(as(root), {
      roleId: reviewers,
      expectedVersion: 1,
      name: `Reviewers ${randomUUID().slice(0, 8)}`,
      permissionKeys: [...reviewKeys, 'identity.platform-role.view'],
      note: 'Let reviewers see roles',
    });
    if (!edited.ok || edited.value.request === null) throw new Error('no request opened');
    const roleRequest = edited.value.request.id;
    expect(await approve(holder, roleRequest)).toEqual(ownSubject);
    expect(await reject(holder, roleRequest)).toEqual(ownSubject);
    expect(await keysOf(reviewers)).toContain('identity.platform-role.view');
    expect((await requestsOf(reviewers)).map((r) => r.status)).toEqual(['open']);

    // The reviewer's own role change (identity.admin-roles), here to the Platform Administrator.
    const promoted = await app
      .get(AssignAdminRole)
      .execute(as(root), { accountId: holder, roleId: pa, note: 'Covers the weekend' });
    if (!promoted.ok || promoted.value.request === null) throw new Error('no request opened');
    expect(await approve(holder, promoted.value.request.id)).toEqual(ownSubject);
    expect(await reject(holder, promoted.value.request.id)).toEqual(ownSubject);
    expect(await roleIdOf(holder)).toBe(pa);

    // Not holding the edited role any more, the same admin may decide its edit.
    expect(await approve(holder, roleRequest)).toMatchObject({
      ok: true,
      value: { status: 'approved' },
    });
    // Another reviewer decides the admin's own change.
    expect(await approve(checker, promoted.value.request.id)).toMatchObject({
      ok: true,
      value: { status: 'approved' },
    });

    // The reviewer's own enabling (identity.admin-status).
    const target = await admin(pa, 'disabled');
    const enabled = await app
      .get(EnableAdminAccount)
      .execute(as(root), { accountId: target, note: 'Back from leave' });
    if (!enabled.ok || enabled.value.request === null) throw new Error('no request opened');
    expect(await approve(target, enabled.value.request.id)).toEqual(ownSubject);
    expect(await reject(target, enabled.value.request.id)).toEqual(ownSubject);
    expect(await statusOf(target)).toBe('active');
    expect((await requestsOf(target)).map((r) => r.status)).toEqual(['open']);
  });

  it("labels a people request with the admin's display name, and a role's name only for a viewer who may list roles", async () => {
    const pa = await seededRole('platform-administrator');
    const root = await admin(pa);
    const checker = await admin(pa);
    // A reviewer who may see the queue and decide people changes, but not list platform roles.
    const reviewer = await admin(
      await customRole(root, [
        'system-requests.request.view',
        'system-requests.people.review',
        'identity.admin-account.view',
      ]),
    );
    const narrow = await customRole(root, ['identity.admin-account.view']);
    const wide = await customRole(root, [
      'identity.admin-account.view',
      'identity.platform-role.view',
    ]);
    const member = await admin(narrow);
    await sql.query(`UPDATE identity.accounts SET display_name = $2 WHERE id = $1`, [
      member,
      'Layla Haddad',
    ]);

    const assigned = await app
      .get(AssignAdminRole)
      .execute(as(root), { accountId: member, roleId: wide, note: 'Needs the role list' });
    if (!assigned.ok || assigned.value.request === null) throw new Error('no request opened');
    const roleName = `Labelled ${randomUUID().slice(0, 8)}`;
    const edited = await app.get(EditPlatformRole).execute(as(root), {
      roleId: narrow,
      expectedVersion: 1,
      name: roleName,
      permissionKeys: ['identity.admin-account.view', 'identity.platform-role.view'],
      note: 'Let them see roles',
    });
    if (!edited.ok || edited.value.request === null) throw new Error('no request opened');

    const view = (viewer: Id<'Account'>, requestId: Id<'SystemRequest'>) =>
      app.get(ViewSystemRequest).execute(as(viewer), { requestId });
    // Any admin who sees the queue sees the admin's display name, never the sign-in address.
    for (const viewer of [checker, reviewer]) {
      expect(await view(viewer, assigned.value.request.id)).toMatchObject({
        ok: true,
        value: { subjectKind: 'identity.admin-roles', subjectLabel: 'Layla Haddad' },
      });
    }
    // The role's name for an admin who may list roles; no label for one who may not.
    expect(await view(checker, edited.value.request.id)).toMatchObject({
      ok: true,
      value: { subjectKind: 'identity.platform-role', subjectLabel: roleName },
    });
    expect(await view(reviewer, edited.value.request.id)).toMatchObject({
      ok: true,
      value: { subjectKind: 'identity.platform-role', subjectLabel: null },
    });
  });

  it('keeps nothing of an enabling or a role edit without a note: no write, audit row or event', async () => {
    const pa = await seededRole('platform-administrator');
    const root = await admin(pa);
    const target = await admin(await seededRole('viewer'), 'disabled');
    expect(
      await app.get(EnableAdminAccount).execute(as(root), { accountId: target }),
    ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    expect(await statusOf(target)).toBe('disabled');
    expect(await auditOf('identity.account.enabled', target)).toEqual([]);
    expect(await outboxTypesOf(target)).toEqual([]);
    expect(await requestsOf(target)).toEqual([]);

    const role = await customRole(root, ['identity.admin-account.view']);
    const version = await roleVersionOf(role);
    const audits = await auditOf('identity.role.updated', role);
    const events = await outboxTypesOf(role);
    expect(
      await app.get(EditPlatformRole).execute(as(root), {
        roleId: role,
        expectedVersion: version,
        name: `Edited ${randomUUID().slice(0, 8)}`,
        permissionKeys: ['identity.admin-account.view', 'identity.platform-role.view'],
      }),
    ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    expect(await keysOf(role)).toEqual(['identity.admin-account.view']);
    expect(await roleVersionOf(role)).toBe(version);
    expect(await auditOf('identity.role.updated', role)).toEqual(audits);
    expect(await outboxTypesOf(role)).toEqual(events);
    expect(await requestsOf(role)).toEqual([]);
  });

  it('disables again an admin whose enabling the author withdraws, ending its sessions', async () => {
    const pa = await seededRole('platform-administrator');
    const root = await admin(pa);
    const target = await admin(await seededRole('viewer'), 'disabled');
    const enabled = await app
      .get(EnableAdminAccount)
      .execute(as(root), { accountId: target, note: 'Back from leave' });
    if (!enabled.ok || enabled.value.request === null) throw new Error('no request opened');
    await sessionOf(target);

    expect(
      await app
        .get(WithdrawSystemRequest)
        .execute(as(root), { requestId: enabled.value.request.id, reason: 'Wrong person' }),
    ).toMatchObject({ ok: true, value: { status: 'reverted', decision: 'withdrawn' } });
    expect(await statusOf(target)).toBe('disabled');
    expect(await revokedReasonsOf(target)).toEqual(['account-disabled']);
    expect(await auditOf('identity.account-status.reverted', target)).toMatchObject([
      { after: { status: 'disabled', requestId: enabled.value.request.id } },
    ]);
  });

  it("refuses an admin's role revert that would widen access or restore the Platform Administrator role", async () => {
    const pa = await seededRole('platform-administrator');
    const root = await admin(pa);
    const checker = await admin(pa);
    const narrow = await customRole(root, ['identity.admin-account.view']);
    const wide = await customRole(root, [
      'identity.admin-account.view',
      'identity.platform-role.view',
    ]);
    const assign = app.get(AssignAdminRole);
    const refused = { ok: false, error: { code: 'system-requests.revert-not-permitted' } };

    const member = await admin(wide);
    const narrowed = await assign.execute(as(root), {
      accountId: member,
      roleId: narrow,
      note: 'Less is enough',
    });
    if (!narrowed.ok || narrowed.value.request === null) throw new Error('no request opened');
    expect(await reject(checker, narrowed.value.request.id)).toEqual(refused);
    expect(await roleIdOf(member)).toBe(narrow);

    const former = await admin(pa);
    const demoted = await assign.execute(as(root), {
      accountId: former,
      roleId: narrow,
      note: 'Steps back',
    });
    if (!demoted.ok || demoted.value.request === null) throw new Error('no request opened');
    expect(await reject(checker, demoted.value.request.id)).toEqual(refused);
    expect(await roleIdOf(former)).toBe(narrow);

    expect((await requestsOf(member)).map((r) => r.status)).toEqual(['open']);
    expect((await requestsOf(former)).map((r) => r.status)).toEqual(['open']);
    expect(await auditOf('identity.account-role.reverted', member)).toEqual([]);
    expect(await auditOf('identity.account-role.reverted', former)).toEqual([]);
  });
});
