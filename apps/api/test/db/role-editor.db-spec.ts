import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Id } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { ListPlatformRoles } from '../../src/modules/identity/application/use-cases/list-platform-roles.use-case';
import { ListSellerRoles } from '../../src/modules/identity/application/use-cases/list-seller-roles.use-case';
import { CreatePlatformRole } from '../../src/modules/identity/application/use-cases/create-platform-role.use-case';
import { DeletePlatformRole } from '../../src/modules/identity/application/use-cases/delete-platform-role.use-case';
import { EditPlatformRole } from '../../src/modules/identity/application/use-cases/edit-platform-role.use-case';
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import { CreateSellerRole } from '../../src/modules/identity/application/use-cases/create-seller-role.use-case';
import { DeleteSellerRole } from '../../src/modules/identity/application/use-cases/delete-seller-role.use-case';
import { EditSellerRole } from '../../src/modules/identity/application/use-cases/edit-seller-role.use-case';
import { ok } from '@mondapac/shared-kernel';
import { realPermissionRegistry } from '../support/permission-registry';
import { PrismaRoleRepository } from '../../src/modules/identity/infrastructure/sellers/prisma-seller-team.repository';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { withRoleLimit } from '../support/role-limits';
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

// Identity slice 10 on PostgreSQL (identity design 5.3, 5.4, 2.3), for both Market fixtures, as
// the application role on the run database: the six role-editor use cases through the real gate
// and Prisma ports, in serializable units. The rows, key rows, events and audit rows they leave
// (the name only in `roles`, never in an event or an audit row), the unique name indexes as
// the backstop, the role foreign key that keeps a held role, the key reconciliation of an edit
// (a stored key the registry dropped goes with the edit), and the seller isolation.

const CREATED = '2026-10-09T00:00:00Z';
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn';
const newId = <T extends string>(): Id<T> =>
  `01990000-0000-7000-8000-${randomBytes(6).toString('hex')}` as Id<T>;
const unique = () => randomUUID().slice(0, 8);

describe.each(TEST_MARKETS)('the role editor in market %s (database, slice 10)', (code) => {
  const market = marketOf(code);
  const other = otherMarketOf(code);
  let app: NestExpressApplication;
  let sql: Client;
  let driver: ReturnType<typeof recordDriverStatements>;
  let db: Persistence;
  let logs: jest.SpyInstance[];

  beforeAll(async () => {
    ({ app } = await createTestApp({
      env: { DATABASE_URL: testDatabaseUrl() },
      override: (builder) => withRoleLimit(builder, 1000),
    }));
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    driver = recordDriverStatements();
    db = createPersistence();
    for (const each of [market, marketOf(other)]) {
      await app
        .get(SeedRoles)
        .execute(testCallContext(each, 'system', `db-editor-${randomUUID()}`), {});
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

  async function seededRole(seedCode: string, scope: string): Promise<Id<'Role'>> {
    const { rows } = await sql.query<{ id: string }>(
      `SELECT id FROM identity.roles WHERE market_id = $1 AND scope = $2 AND seed_code = $3`,
      [code, scope, seedCode],
    );
    return rows[0]!.id as Id<'Role'>;
  }

  async function account(
    population: 'admin' | 'seller',
    roleId: Id<'Role'>,
    sellerId: Id<'Seller'> | null,
  ): Promise<Id<'Account'>> {
    const id = newId<'Account'>();
    const email = `Editor.${id}@Roles.example`;
    await sql.query(
      `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
       email_normalized, display_name, status, email_verified_at, signed_up_at, version, created_at)
       VALUES ($1, $2, 'default', $6, $3, $4, 'Role Editor', 'active', $5, $5, 1, $5)`,
      [id, code, email, email.toLowerCase(), CREATED, population],
    );
    await sql.query(
      `INSERT INTO identity.password_credentials
         (market_id, tenant_id, account_id, password_hash, changed_at)
       VALUES ($1, 'default', $2, $3, $4)`,
      [code, id, PASSWORD_HASH, CREATED],
    );
    if (sellerId !== null) {
      await sql.query(
        `INSERT INTO identity.seller_memberships (id, market_id, tenant_id, account_id, seller_id,
         state, removed_at, version, created_at)
         VALUES ($1, $2, 'default', $3, $4, 'active', NULL, 1, $5)`,
        [newId(), code, id, sellerId, CREATED],
      );
    }
    await sql.query(
      `INSERT INTO identity.role_assignments (id, market_id, tenant_id, account_id, role_id,
       assigned_by_account_id, assigned_at, version)
       VALUES ($1, $2, 'default', $3, $4, NULL, $5, 1)`,
      [newId(), code, id, roleId, CREATED],
    );
    return id;
  }

  async function seller(): Promise<Id<'Seller'>> {
    const sellerId = newId<'Seller'>();
    await sql.query(
      `INSERT INTO identity.seller_access (seller_id, market_id, tenant_id, origin, state,
         state_changed_at, reapply_count, registered_at, version, created_at)
       VALUES ($1, $2, 'default', 'self', 'approved', $3, 0, $3, 1, $3)`,
      [sellerId, code, CREATED],
    );
    return sellerId;
  }

  const asAdmin = (accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId,
        sessionId: newId<'Session'>(),
        sellerId: null,
      }),
      `db-editor-${randomUUID()}`,
    );
  const asSeller = (accountId: Id<'Account'>, sellerId: Id<'Seller'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId,
        sessionId: newId<'Session'>(),
        sellerId,
      }),
      `db-editor-${randomUUID()}`,
    );

  async function keysOf(roleId: string): Promise<string[]> {
    const { rows } = await sql.query<{ permission_key: string }>(
      `SELECT permission_key FROM identity.role_permissions WHERE market_id = $1 AND role_id = $2
       ORDER BY permission_key`,
      [code, roleId],
    );
    return rows.map((r) => r.permission_key);
  }

  it('creates, edits and deletes a platform role: rows, keys, events and audit rows', async () => {
    const root = await account(
      'admin',
      await seededRole('platform-administrator', 'platform'),
      null,
    );
    const name = `Canary Role ${unique()}`;

    const created = await app.get(CreatePlatformRole).execute(asAdmin(root), {
      name: `  ${name}  `,
      permissionKeys: ['identity.platform-role.view', 'identity.admin-account.invite'],
    });
    if (!created.ok) throw new Error(created.error.code);
    const roleId = created.value.roleId;

    const row = await sql.query(
      `SELECT scope, kind, name, name_normalized, seller_id, version FROM identity.roles
       WHERE market_id = $1 AND id = $2`,
      [code, roleId],
    );
    expect(row.rows).toEqual([
      {
        scope: 'platform',
        kind: 'custom',
        name,
        name_normalized: name.toLowerCase(),
        seller_id: null,
        version: 1,
      },
    ]);
    expect(await keysOf(roleId)).toEqual([
      'identity.admin-account.invite',
      'identity.platform-role.view',
    ]);

    // A stored key the registry no longer declares: the edit removes it with the others.
    await sql.query(
      `INSERT INTO identity.role_permissions (market_id, tenant_id, role_id, permission_key)
       VALUES ($1, 'default', $2, 'identity.retired.key')`,
      [code, roleId],
    );
    const edited = await app.get(EditPlatformRole).execute(asAdmin(root), {
      roleId,
      name: `${name} 2`,
      permissionKeys: ['identity.platform-role.view', 'identity.seller-access.view'],
    });
    expect(edited).toEqual({ ok: true, value: { code: 'role.updated', roleId } });
    expect(await keysOf(roleId)).toEqual([
      'identity.platform-role.view',
      'identity.seller-access.view',
    ]);
    const versions = await sql.query(
      `SELECT version FROM identity.roles WHERE market_id = $1 AND id = $2`,
      [code, roleId],
    );
    expect(versions.rows).toEqual([{ version: 2 }]);

    const listed = await app.get(ListPlatformRoles).execute(asAdmin(root), {});
    if (!listed.ok) throw new Error(listed.error.code);
    expect(listed.value.items.find((i) => i.roleId === roleId)).toMatchObject({
      name: `${name} 2`,
      permissionCount: 2,
      version: 2,
    });

    const removed = await app.get(DeletePlatformRole).execute(asAdmin(root), { roleId });
    expect(removed).toEqual({ ok: true, value: { code: 'role.deleted', roleId } });
    expect(await keysOf(roleId)).toEqual([]);

    const outbox = await sql.query<{ type: string; payload: unknown }>(
      `SELECT type, payload FROM identity.outbox WHERE market_id = $1 AND aggregate_id = $2
       ORDER BY aggregate_version`,
      [code, roleId],
    );
    expect(outbox.rows.map((r) => r.type)).toEqual([
      'identity.role-created.v1',
      'identity.role-updated.v1',
      'identity.role-deleted.v1',
    ]);
    const audits = await sql.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM platform.audit_log WHERE market_id = $1 AND target_id = $2
       ORDER BY action`,
      [code, roleId],
    );
    expect(audits.rows).toEqual([
      { action: 'identity.role.created', actor_id: root },
      { action: 'identity.role.deleted', actor_id: root },
      { action: 'identity.role.updated', actor_id: root },
    ]);
    // R5: the name is in `roles` and nowhere else.
    expect(JSON.stringify([outbox.rows, audits.rows])).not.toContain('Canary');
    const everywhere = await sql.query(
      `SELECT 1 FROM platform.audit_log WHERE market_id = $1 AND (before::text LIKE $2 OR after::text LIKE $2)`,
      [code, '%Canary%'],
    );
    expect(everywhere.rowCount).toBe(0);
  });

  it('refuses a taken name (case and form), keeps a held role, and the indexes back the checks', async () => {
    const root = await account(
      'admin',
      await seededRole('platform-administrator', 'platform'),
      null,
    );
    const name = `Taken ${unique()}`;
    const first = await app
      .get(CreatePlatformRole)
      .execute(asAdmin(root), { name, permissionKeys: [] });
    if (!first.ok) throw new Error(first.error.code);

    const clash = await app
      .get(CreatePlatformRole)
      .execute(asAdmin(root), { name: name.toUpperCase(), permissionKeys: [] });
    expect(clash).toEqual({ ok: false, error: { code: 'role.name-taken' } });

    // The partial unique index is the backstop when a writer skips the check.
    await expect(
      sql.query(
        `INSERT INTO identity.roles (id, market_id, tenant_id, scope, kind, name, name_normalized,
         version, created_at) VALUES ($1, $2, 'default', 'platform', 'custom', $3, $4, 1, $5)`,
        [newId(), code, name.toUpperCase(), name.toLowerCase(), CREATED],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // A role an account holds cannot be deleted: use case and foreign key agree.
    await account('admin', first.value.roleId, null);
    const held = await app
      .get(DeletePlatformRole)
      .execute(asAdmin(root), { roleId: first.value.roleId });
    expect(held).toEqual({ ok: false, error: { code: 'role.in-use' } });
    await expect(
      sql.query(`DELETE FROM identity.roles WHERE market_id = $1 AND id = $2`, [
        code,
        first.value.roleId,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('keeps the seller roles of one shop from every other shop, and from the platform scope', async () => {
    const ownerRole = await seededRole('seller-owner', 'seller');
    const mine = await seller();
    const theirs = await seller();
    const owner = await account('seller', ownerRole, mine);
    const rival = await account('seller', ownerRole, theirs);
    const name = `Shift ${unique()}`;

    const created = await app.get(CreateSellerRole).execute(asSeller(owner, mine), {
      name,
      permissionKeys: ['identity.team-member.view'],
    });
    if (!created.ok) throw new Error(created.error.code);
    const roleId = created.value.roleId;
    const row = await sql.query(
      `SELECT scope, seller_id FROM identity.roles WHERE market_id = $1 AND id = $2`,
      [code, roleId],
    );
    expect(row.rows).toEqual([{ scope: 'seller', seller_id: mine }]);
    // The same name in another shop is fine (per-owner uniqueness).
    const sameName = await app.get(CreateSellerRole).execute(asSeller(rival, theirs), {
      name,
      permissionKeys: [],
    });
    expect(sameName.ok).toBe(true);

    // The other shop sees neither the role nor can it touch it.
    const theirList = await app.get(ListSellerRoles).execute(asSeller(rival, theirs), {});
    if (!theirList.ok) throw new Error(theirList.error.code);
    expect(theirList.value.items.map((i) => i.roleId)).not.toContain(roleId);
    expect(
      await app
        .get(EditSellerRole)
        .execute(asSeller(rival, theirs), { roleId, name: 'Mine now', permissionKeys: [] }),
    ).toEqual({ ok: false, error: { code: 'role.unknown' } });
    expect(await app.get(DeleteSellerRole).execute(asSeller(rival, theirs), { roleId })).toEqual({
      ok: false,
      error: { code: 'role.unknown' },
    });
    // An admin cannot use the seller editor, and a seller role id is unknown to the admin editor.
    const root = await account(
      'admin',
      await seededRole('platform-administrator', 'platform'),
      null,
    );
    expect(
      await app.get(CreateSellerRole).execute(asAdmin(root), { name: 'x', permissionKeys: [] }),
    ).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(await app.get(DeletePlatformRole).execute(asAdmin(root), { roleId })).toEqual({
      ok: false,
      error: { code: 'role.unknown' },
    });

    const mineList = await app.get(ListSellerRoles).execute(asSeller(owner, mine), {});
    if (!mineList.ok) throw new Error(mineList.error.code);
    const entry = mineList.value.items.find((i) => i.roleId === roleId)!;
    expect(entry).toMatchObject({ name, kind: 'custom', permissionCount: 1 });
    const { rows } = await sql.query<{
      market_id: string;
      scope: string;
      seller_id: string | null;
    }>('SELECT market_id, scope, seller_id FROM identity.roles WHERE id = ANY($1::uuid[])', [
      mineList.value.items.map((i) => i.roleId),
    ]);
    for (const each of rows) {
      expect([each.market_id, each.scope]).toEqual([code, 'seller']);
      expect([null, mine]).toContain(each.seller_id);
    }

    expect(await app.get(DeleteSellerRole).execute(asSeller(owner, mine), { roleId })).toEqual({
      ok: true,
      value: { code: 'role.deleted', roleId },
    });
  });

  it('reads the catalogues in read-only units and puts the Market in every statement', async () => {
    const root = await account(
      'admin',
      await seededRole('platform-administrator', 'platform'),
      null,
    );
    const ownerRole = await seededRole('seller-owner', 'seller');
    const mine = await seller();
    const owner = await account('seller', ownerRole, mine);

    const platform = await driver.during(() =>
      app.get(ListPlatformRoles).execute(asAdmin(root), {}),
    );
    const platformStatements = [...driver.statements];
    const sellers = await driver.during(() =>
      app.get(ListSellerRoles).execute(asSeller(owner, mine), {}),
    );
    const sellerStatements = [...driver.statements];

    expect([platform.ok, sellers.ok]).toEqual([true, true]);
    for (const statement of [...platformStatements, ...sellerStatements]) {
      expect(statement.trim()).not.toMatch(/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/i);
      expect(statement.trim()).toMatch(/^SELECT/i);
      if (/identity\."?(roles|role_permissions|role_assignments)"?/i.test(statement)) {
        expect(statement).toMatch(/"market_id"\s*=/i);
      }
    }
  });

  it('two concurrent edits of one role: one version step per write, the key rows are the winner’s', async () => {
    const root = await account(
      'admin',
      await seededRole('platform-administrator', 'platform'),
      null,
    );
    const made = await app
      .get(CreatePlatformRole)
      .execute(asAdmin(root), { name: `Race ${unique()}`, permissionKeys: [] });
    if (!made.ok) throw new Error(made.error.code);
    const roleId = made.value.roleId;
    const sets = [['identity.seller-access.view'], ['identity.customer-account.view']];

    const settled = await Promise.allSettled(
      sets.map((permissionKeys, n) =>
        app
          .get(EditPlatformRole)
          .execute(asAdmin(root), { roleId, name: `Racer ${n} ${unique()}`, permissionKeys }),
      ),
    );

    // Each wrote (a version step) or lost the race with a conflict error that the platform
    // filter answers 409 (conflict.stale or conflict.retry); never a half write.
    for (const result of settled) {
      if (result.status === 'rejected') {
        expect(['StaleAggregateError', 'TransactionConflictError']).toContain(
          (result.reason as Error).name,
        );
      }
    }
    const written = settled.filter((r) => r.status === 'fulfilled').length;
    expect(written).toBeGreaterThan(0);
    const row = await sql.query<{ version: number; name: string }>(
      `SELECT version, name FROM identity.roles WHERE market_id = $1 AND id = $2`,
      [code, roleId],
    );
    expect(row.rows[0]!.version).toBe(1 + written);
    const keys = await keysOf(roleId);
    expect(keys).toHaveLength(1);
    // The name and the key belong to the same writer.
    const winner = sets.findIndex((k) => k[0] === keys[0]);
    expect(winner).toBeGreaterThanOrEqual(0);
    expect(row.rows[0]!.name.startsWith(`Racer ${winner} `) || written === 2).toBe(true);
  });

  it('an edit racing a delete: gone with no key rows, or edited; never both', async () => {
    const root = await account(
      'admin',
      await seededRole('platform-administrator', 'platform'),
      null,
    );
    const made = await app.get(CreatePlatformRole).execute(asAdmin(root), {
      name: `Doomed ${unique()}`,
      permissionKeys: ['identity.seller-access.view'],
    });
    if (!made.ok) throw new Error(made.error.code);
    const roleId = made.value.roleId;

    const settled = await Promise.allSettled([
      app.get(EditPlatformRole).execute(asAdmin(root), {
        roleId,
        name: `Edited ${unique()}`,
        permissionKeys: ['identity.customer-account.view'],
      }),
      app.get(DeletePlatformRole).execute(asAdmin(root), { roleId }),
    ]);

    for (const result of settled) {
      if (result.status === 'rejected') {
        expect(['StaleAggregateError', 'TransactionConflictError']).toContain(
          (result.reason as Error).name,
        );
      }
    }
    const row = await sql.query(`SELECT 1 FROM identity.roles WHERE market_id = $1 AND id = $2`, [
      code,
      roleId,
    ]);
    const keys = await keysOf(roleId);
    const deleted = settled[1].status === 'fulfilled' && settled[1].value.ok;
    if (deleted) expect([row.rowCount, keys]).toEqual([0, []]);
    else {
      expect(row.rowCount).toBe(1);
      expect(keys.length).toBeLessThanOrEqual(1);
    }
  });

  it('a write at an old version is stale: the version-guarded update refuses it', async () => {
    const root = await account(
      'admin',
      await seededRole('platform-administrator', 'platform'),
      null,
    );
    const made = await app
      .get(CreatePlatformRole)
      .execute(asAdmin(root), { name: `Old ${unique()}`, permissionKeys: [] });
    if (!made.ok) throw new Error(made.error.code);
    const roles = new PrismaRoleRepository(db.service);
    const read = await db.unitOfWork.run(market, async () =>
      ok(await roles.findById(market, made.value.roleId)),
    );
    if (!read.ok) throw new Error('read');
    const role = read.value!;
    const edit = role.edit({
      name: `Newer ${unique()}`,
      permissionKeys: [],
      isDeclared: () => true,
      now: role.state.createdAt,
    });
    await db.unitOfWork.run(market, async () => ok(await roles.saveCustom(market, edit)));

    await expect(
      db.unitOfWork.run(market, async () => ok(await roles.saveCustom(market, edit))),
    ).rejects.toBeInstanceOf(StaleAggregateError);
    await expect(
      db.unitOfWork.run(market, async () => ok(await roles.deleteCustom(market, role))),
    ).rejects.toBeInstanceOf(StaleAggregateError);
  });

  it.each(['platform', 'seller'] as const)(
    'writes the longest declared keys (up to 40) in a %s role through the 4 KB audit writer',
    async (scope) => {
      const sellerId = scope === 'seller' ? await seller() : null;
      const actor =
        scope === 'seller'
          ? await account('seller', await seededRole('seller-owner', 'seller'), sellerId)
          : await account('admin', await seededRole('platform-administrator', 'platform'), null);
      const context = scope === 'seller' ? asSeller(actor, sellerId!) : asAdmin(actor);
      const keys = realPermissionRegistry()
        .list(scope)
        .filter((d) => scope === 'platform' || !d.protected)
        .map((d) => d.key)
        .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
        .slice(0, 40);
      const create = scope === 'seller' ? CreateSellerRole : CreatePlatformRole;
      const edit = scope === 'seller' ? EditSellerRole : EditPlatformRole;
      const remove = scope === 'seller' ? DeleteSellerRole : DeletePlatformRole;

      const made = await app
        .get(create)
        .execute(context, { name: `Long ${unique()}`, permissionKeys: keys });
      if (!made.ok) throw new Error(JSON.stringify(made.error));
      const roleId = made.value.roleId;
      // Everything out again: the `removedKeys` side is as large as the `addedKeys` side was.
      const emptied = await app
        .get(edit)
        .execute(context, { roleId, name: `Long ${unique()}`, permissionKeys: [] });
      const gone = await app.get(remove).execute(context, { roleId });

      expect([emptied.ok, gone.ok]).toEqual([true, true]);
      const audits = await sql.query<{ action: string }>(
        `SELECT action FROM platform.audit_log WHERE market_id = $1 AND target_id = $2
         ORDER BY action`,
        [code, roleId],
      );
      expect(audits.rows.map((r) => r.action)).toEqual([
        'identity.role.created',
        'identity.role.deleted',
        'identity.role.updated',
      ]);
    },
  );

  it('seller scope: a role a member holds is role.in-use; once free it is deleted', async () => {
    const mine = await seller();
    const owner = await account('seller', await seededRole('seller-owner', 'seller'), mine);
    const made = await app.get(CreateSellerRole).execute(asSeller(owner, mine), {
      name: `Held ${unique()}`,
      permissionKeys: ['identity.team-member.view'],
    });
    if (!made.ok) throw new Error(made.error.code);
    const member = await account('seller', made.value.roleId, mine);

    const held = await app
      .get(DeleteSellerRole)
      .execute(asSeller(owner, mine), { roleId: made.value.roleId });
    await sql.query(
      `DELETE FROM identity.role_assignments WHERE market_id = $1 AND account_id = $2`,
      [code, member],
    );
    const free = await app
      .get(DeleteSellerRole)
      .execute(asSeller(owner, mine), { roleId: made.value.roleId });

    expect(held).toEqual({ ok: false, error: { code: 'role.in-use' } });
    expect(free.ok).toBe(true);
  });
});

describe.each(TEST_MARKETS)('the role limit in market %s (database, slice 10)', (code) => {
  let app: NestExpressApplication;
  let sql: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp({
      env: { DATABASE_URL: testDatabaseUrl() },
      override: (builder) => withRoleLimit(builder, 1),
    }));
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    await app
      .get(SeedRoles)
      .execute(testCallContext(marketOf(code), 'system', `db-limit-${randomUUID()}`), {});
  });
  afterAll(async () => {
    await sql.end();
    await app.close();
  });

  it('counts a shop’s own custom roles: one fits, the second is role.limit, another shop is free', async () => {
    const market = marketOf(code);
    const ownerRole = (
      await sql.query<{ id: string }>(
        `SELECT id FROM identity.roles WHERE market_id = $1 AND scope = 'seller'
         AND seed_code = 'seller-owner'`,
        [code],
      )
    ).rows[0]!.id as Id<'Role'>;
    const shop = async () => {
      const sellerId = newId<'Seller'>();
      await sql.query(
        `INSERT INTO identity.seller_access (seller_id, market_id, tenant_id, origin, state,
           state_changed_at, reapply_count, registered_at, version, created_at)
         VALUES ($1, $2, 'default', 'self', 'approved', $3, 0, $3, 1, $3)`,
        [sellerId, code, CREATED],
      );
      const id = newId<'Account'>();
      const email = `Limit.${id}@Roles.example`;
      await sql.query(
        `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
         email_normalized, display_name, status, email_verified_at, signed_up_at, version,
         created_at)
         VALUES ($1, $2, 'default', 'seller', $3, $4, 'Owner', 'active', $5, $5, 1, $5)`,
        [id, code, email, email.toLowerCase(), CREATED],
      );
      await sql.query(
        `INSERT INTO identity.password_credentials
           (market_id, tenant_id, account_id, password_hash, changed_at)
         VALUES ($1, 'default', $2, $3, $4)`,
        [code, id, PASSWORD_HASH, CREATED],
      );
      await sql.query(
        `INSERT INTO identity.seller_memberships (id, market_id, tenant_id, account_id,
           seller_id, state, removed_at, version, created_at)
         VALUES ($1, $2, 'default', $3, $4, 'active', NULL, 1, $5)`,
        [newId(), code, id, sellerId, CREATED],
      );
      await sql.query(
        `INSERT INTO identity.role_assignments (id, market_id, tenant_id, account_id, role_id,
           assigned_by_account_id, assigned_at, version)
         VALUES ($1, $2, 'default', $3, $4, NULL, $5, 1)`,
        [newId(), code, id, ownerRole, CREATED],
      );
      return testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: id,
          sessionId: newId<'Session'>(),
          sellerId,
        }),
        `db-limit-${randomUUID()}`,
      );
    };
    const [one, two] = [await shop(), await shop()];

    const first = await app
      .get(CreateSellerRole)
      .execute(one, { name: 'First', permissionKeys: [] });
    const second = await app
      .get(CreateSellerRole)
      .execute(one, { name: 'Second', permissionKeys: [] });
    const other = await app
      .get(CreateSellerRole)
      .execute(two, { name: 'First', permissionKeys: [] });

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, error: { code: 'role.limit' } });
    expect(other.ok).toBe(true);
  });
});
