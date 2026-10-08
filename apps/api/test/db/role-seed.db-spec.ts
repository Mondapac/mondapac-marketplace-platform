import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import {
  ROLE_GRANT_READER,
  type RoleGrantReader,
} from '../../src/modules/identity/application/ports/role-grant-reader';
import {
  ROLE_SEED,
  type RoleSeed,
  type SeededRole,
} from '../../src/modules/identity/application/ports/role-seed';
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import {
  SELLER_ACCESS_APPROVE,
  SELLER_ACCESS_VIEW,
  SELLER_ROLE_VIEW,
  TEAM_MEMBER_VIEW,
} from '../../src/modules/identity/contracts/permissions';
import { CheckedInRoleSeed } from '../../src/modules/identity/infrastructure/seed/checked-in-role-seed';
import {
  AUTHORISATION_CHECK,
  type AccessDeclaration,
  type AuthorisationCheck,
} from '../../src/platform/authz';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The role seed and the permission path of slice 8a-1 on PostgreSQL (identity design 5.5, 5.6,
// 6.7; platform-audit 14), for both Market fixtures, as the application role: the default
// roles of 5.6 with their key rows, the audited seed-version upgrade through the real audit
// writer (whose permission-key check is the registry since this slice, so a row naming keys is
// accepted), and the grant read with the real AuthorisationCheck for admin fixture accounts.
// Admin accounts and their assignments are inserted by SQL here: no seed, route or script
// creates an admin (platform-audit 14 condition 1). Roles are shared rows of a Market, so this
// file asserts on its own seed codes and on the checked-in roles, never on counts of the table.

const CREATED = '2026-10-08T00:00:00Z';
/** A fresh id in the shape the shared kernel parses (version 7). */
const newId = <T extends string>(): Id<T> =>
  `01990000-0000-7000-8000-${randomBytes(6).toString('hex')}` as Id<T>;

describe.each(TEST_MARKETS)(
  'the role seed and the permission path in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    const checkedIn = new CheckedInRoleSeed().roles();
    /** Roles a test adds to the checked-in seed, under seed codes of its own. */
    let extra: SeededRole[] = [];
    const seed: RoleSeed = { roles: () => [...checkedIn, ...extra] };
    let app: NestExpressApplication;
    let sql: Client;
    let logs: jest.SpyInstance[];

    beforeAll(async () => {
      ({ app } = await createTestApp({
        env: { DATABASE_URL: testDatabaseUrl() },
        override: (builder) => builder.overrideProvider(ROLE_SEED).useValue(seed),
      }));
      sql = new Client({ connectionString: testDatabaseUrl() });
      await sql.connect();
    });
    afterAll(async () => {
      await sql.end();
      await app.close();
    });
    beforeEach(() => {
      extra = [];
      logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
      );
    });
    afterEach(() => logs.forEach((spy) => spy.mockRestore()));

    const system = () => testCallContext(market, 'system', `db-role-seed-${randomUUID()}`);
    const seedRoles = () => app.get(SeedRoles).execute(system(), {});

    async function roleRow(scope: string, seedCode: string) {
      const { rows } = await sql.query<{
        id: string;
        kind: string;
        seed_version: number;
        version: number;
        seller_id: string | null;
      }>(
        `SELECT id, kind, seed_version, version, seller_id FROM identity.roles
        WHERE market_id = $1 AND scope = $2 AND seed_code = $3`,
        [code, scope, seedCode],
      );
      expect(rows).toHaveLength(1);
      return rows[0]!;
    }

    async function keysOf(roleId: string): Promise<string[]> {
      const { rows } = await sql.query<{ permission_key: string }>(
        `SELECT permission_key FROM identity.role_permissions
        WHERE market_id = $1 AND role_id = $2 ORDER BY permission_key`,
        [code, roleId],
      );
      return rows.map((r) => r.permission_key);
    }

    it('creates the roles of 5.6 as shared rows with their keys; a second run changes nothing', async () => {
      await expect(seedRoles()).resolves.toMatchObject({ ok: true });

      for (const role of checkedIn) {
        const row = await roleRow(role.scope, role.seedCode);
        expect([role.seedCode, row.kind, row.seller_id, row.seed_version]).toEqual([
          role.seedCode,
          role.kind,
          null,
          role.seedVersion,
        ]);
        // A system role stores no key: it holds every key of its scope (5.5).
        expect([role.seedCode, await keysOf(row.id)]).toEqual([
          role.seedCode,
          role.kind === 'system' ? [] : [...role.permissionKeys].sort(),
        ]);
      }
      await expect(seedRoles()).resolves.toEqual({ ok: true, value: { created: 0, upgraded: 0 } });
    });

    it('upgrades a newer seed version: the key rows change and one audited seed-applied row names them', async () => {
      const seedCode = `db-upgrade-${randomBytes(4).toString('hex')}`;
      const role = (seedVersion: number, permissionKeys: string[]): SeededRole => ({
        scope: 'seller',
        kind: 'default',
        seedCode,
        seedVersion,
        nameKey: 'identity.role.store-manager',
        permissionKeys,
      });
      extra = [role(1, [TEAM_MEMBER_VIEW.key])];
      await expect(seedRoles()).resolves.toEqual({ ok: true, value: { created: 1, upgraded: 0 } });
      const created = await roleRow('seller', seedCode);
      expect(await keysOf(created.id)).toEqual([TEAM_MEMBER_VIEW.key]);

      extra = [role(2, [SELLER_ROLE_VIEW.key])];
      await expect(seedRoles()).resolves.toEqual({ ok: true, value: { created: 0, upgraded: 1 } });

      const upgraded = await roleRow('seller', seedCode);
      expect([upgraded.id, upgraded.seed_version, upgraded.version]).toEqual([created.id, 2, 2]);
      expect(await keysOf(created.id)).toEqual([SELLER_ROLE_VIEW.key]);
      const { rows: audit } = await sql.query<{
        action: string;
        actor_type: string;
        target_type: string;
        before: unknown;
        after: unknown;
      }>(
        `SELECT action, actor_type, target_type, before, after FROM platform.audit_log
        WHERE market_id = $1 AND target_id = $2 ORDER BY occurred_at, action`,
        [code, created.id],
      );
      expect(audit.map((row) => row.action).sort()).toEqual([
        'identity.role.seed-applied',
        'identity.role.seeded',
      ]);
      expect(audit.find((row) => row.action === 'identity.role.seed-applied')).toMatchObject({
        actor_type: 'SYSTEM',
        target_type: 'identity.role',
        before: { seedVersion: 1 },
        after: {
          seedVersion: 2,
          addedKeys: [SELLER_ROLE_VIEW.key],
          removedKeys: [TEAM_MEMBER_VIEW.key],
        },
      });

      // The same version again, and an older one, change nothing.
      await expect(seedRoles()).resolves.toEqual({ ok: true, value: { created: 0, upgraded: 0 } });
      extra = [role(1, [TEAM_MEMBER_VIEW.key])];
      await expect(seedRoles()).resolves.toEqual({ ok: true, value: { created: 0, upgraded: 0 } });
      expect(await keysOf(created.id)).toEqual([SELLER_ROLE_VIEW.key]);
    });

    describe('admin fixture accounts (tests only) and a Seller Owner', () => {
      /** Every stored account has one password credential (data design 5). */
      const insertCredential = (accountId: string) =>
        sql.query(
          `INSERT INTO identity.password_credentials
             (market_id, tenant_id, account_id, password_hash, changed_at)
           VALUES ($1, 'default', $2, $3, $4)`,
          [code, accountId, '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn', CREATED],
        );

      async function adminWith(seedCode: string | null): Promise<Id<'Account'>> {
        const id = newId<'Account'>();
        const email = `Admin.${id}@Admin.example`;
        await sql.query(
          `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
           email_normalized, display_name, status, email_verified_at, signed_up_at, version,
           created_at)
         VALUES ($1, $2, 'default', 'admin', $3, $4, 'Admin', 'active', $5, $5, 1, $5)`,
          [id, code, email, email.toLowerCase(), CREATED],
        );
        await insertCredential(id);
        if (seedCode !== null) {
          const role = await roleRow('platform', seedCode);
          await sql.query(
            `INSERT INTO identity.role_assignments (id, market_id, tenant_id, account_id, role_id,
             assigned_by_account_id, assigned_at, version)
           VALUES ($1, $2, 'default', $3, $4, NULL, $5, 1)`,
            [newId(), code, id, role.id, CREATED],
          );
        }
        return id;
      }

      /** An owner of an approved seller with the Seller Owner role, inserted as fixture rows. */
      async function sellerOwner(): Promise<{ accountId: Id<'Account'>; sellerId: Id<'Seller'> }> {
        const accountId = newId<'Account'>();
        const sellerId = newId<'Seller'>();
        const email = `Owner.${accountId}@Seller.example`;
        await sql.query(
          `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
             email_normalized, display_name, status, email_verified_at, signed_up_at, version,
             created_at)
           VALUES ($1, $2, 'default', 'seller', $3, $4, 'Owner', 'active', $5, $5, 1, $5)`,
          [accountId, code, email, email.toLowerCase(), CREATED],
        );
        await insertCredential(accountId);
        await sql.query(
          `INSERT INTO identity.seller_access (seller_id, market_id, tenant_id, origin, state,
             state_changed_at, reapply_count, registered_at, version, created_at)
           VALUES ($1, $2, 'default', 'self', 'approved', $3, 0, $3, 1, $3)`,
          [sellerId, code, CREATED],
        );
        await sql.query(
          `INSERT INTO identity.seller_memberships (id, market_id, tenant_id, account_id,
             seller_id, state, removed_at, version, created_at)
           VALUES ($1, $2, 'default', $3, $4, 'active', NULL, 1, $5)`,
          [newId(), code, accountId, sellerId, CREATED],
        );
        const role = await roleRow('seller', 'seller-owner');
        await sql.query(
          `INSERT INTO identity.role_assignments (id, market_id, tenant_id, account_id, role_id,
             assigned_by_account_id, assigned_at, version)
           VALUES ($1, $2, 'default', $3, $4, NULL, $5, 1)`,
          [newId(), code, accountId, role.id, CREATED],
        );
        return { accountId, sellerId };
      }

      const needs = (key: string): AccessDeclaration => ({
        name: 'identity.db-fixture',
        rule: { kind: 'permissions', allOf: [key as never] },
      });
      const as = (accountId: Id<'Account'>) =>
        testCallContext(
          market,
          testAuthenticatedActor(market, {
            population: 'admin',
            accountId,
            sessionId: newId<'Session'>(),
            sellerId: null,
          }),
        );

      it('reads the grants and decides the keys through the real AuthorisationCheck', async () => {
        await seedRoles();
        const administrator = await adminWith('platform-administrator');
        const compliance = await adminWith('onboarding-compliance');
        const moderator = await adminWith('catalogue-moderator');
        const noRole = await adminWith(null);

        const read = await app
          .get<UnitOfWork>(UNIT_OF_WORK)
          .run(
            market,
            async () =>
              ok(
                await app
                  .get<RoleGrantReader>(ROLE_GRANT_READER)
                  .grantsOf(market, [administrator, compliance, noRole]),
              ),
            { readOnly: true },
          );
        if (!read.ok) throw new Error('the grant read failed');
        const grants = read.value;
        expect(grants.get(administrator)).toMatchObject({
          kind: 'system',
          scope: 'platform',
          storedKeys: [],
        });
        expect(grants.get(compliance)).toMatchObject({ kind: 'default', scope: 'platform' });
        expect([...grants.get(compliance)!.storedKeys].sort()).toEqual(
          [...checkedIn.find((r) => r.seedCode === 'onboarding-compliance')!.permissionKeys].sort(),
        );
        expect(grants.has(noRole)).toBe(false);

        const check = app.get<AuthorisationCheck>(AUTHORISATION_CHECK);
        const allowed = async (accountId: Id<'Account'>, key: string) =>
          (await check.check(as(accountId), needs(key))).allowed;
        expect(await allowed(administrator, SELLER_ACCESS_APPROVE.key)).toBe(true);
        expect(await allowed(compliance, SELLER_ACCESS_APPROVE.key)).toBe(true);
        expect(await allowed(moderator, SELLER_ACCESS_APPROVE.key)).toBe(false);
        expect(await allowed(moderator, SELLER_ACCESS_VIEW.key)).toBe(true);
        expect(await allowed(noRole, SELLER_ACCESS_VIEW.key)).toBe(false);
        // A platform role never reaches a seller key, not even the Platform Administrator's.
        expect(await allowed(administrator, TEAM_MEMBER_VIEW.key)).toBe(false);
      });

      it('admits the Seller Owner under every seller key and no platform key (R3)', async () => {
        await seedRoles();
        const { accountId, sellerId } = await sellerOwner();
        const context = testCallContext(
          market,
          testAuthenticatedActor(market, {
            population: 'seller',
            accountId,
            sessionId: newId<'Session'>(),
            sellerId,
          }),
        );
        const check = app.get<AuthorisationCheck>(AUTHORISATION_CHECK);

        for (const key of [TEAM_MEMBER_VIEW.key, SELLER_ROLE_VIEW.key]) {
          await expect(check.check(context, needs(key))).resolves.toEqual({ allowed: true });
        }
        await expect(check.check(context, needs(SELLER_ACCESS_VIEW.key))).resolves.toMatchObject({
          allowed: false,
        });
      });
    });
  },
);
