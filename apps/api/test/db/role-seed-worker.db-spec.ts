import { devNull } from 'node:os';
import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import pino from 'pino';
import { AppModule } from '../../src/app.module';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../src/modules/catalog/contracts/permissions';
import { SEED_ROLES_JOB } from '../../src/modules/identity/presentation/jobs/seed-roles.job';
import { PermissionRegistry } from '../../src/platform/authz';
import { Scheduler } from '../../src/platform/scheduler/scheduler';
import { testAppConfig, TEST_MARKETS } from '../support/test-config';
import { testDatabaseUrl } from './test-database';

// Slice I-1a (catalog request I-1; Ali 2026-10-09, condition "worker registry"): the
// `identity.seed-roles` job as the `worker` role runs it. The graph is built for APP_ROLE=worker
// and bootstrapped as `startWorker` does before `WorkerRuntime.start()`; the job then runs
// through the real Scheduler, as the runtime's first tick (`runAtStart`) runs it. The seed
// re-checks every key against the sealed registry on each run, so a worker that had not
// registered catalog's catalogue would fail the job with `unknown-key` for every Market.
//
// Other files seed the same shared roles concurrently; this file only asserts what holds
// whichever run applies the upgrade: the job fails for no Market, the role ends at version 2
// with the key, and exactly one v1 -> v2 seed-applied row names the key.

const EDIT = CATALOG_PLATFORM_PRODUCT_EDIT.key;

describe('identity.seed-roles in the worker role (slice I-1a; database integration)', () => {
  let worker: INestApplicationContext;
  let sql: Client;
  let logs: jest.SpyInstance[];

  beforeAll(async () => {
    worker = await (
      await Test.createTestingModule({
        imports: [
          AppModule.register({
            config: testAppConfig({ APP_ROLE: 'worker', DATABASE_URL: testDatabaseUrl() }),
            logDestination: pino.destination(devNull),
          }),
        ],
      }).compile()
    ).init();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await sql.end();
    await worker.close();
  });
  beforeEach(() => {
    logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });
  afterEach(() => logs.forEach((spy) => spy.mockRestore()));

  const runSeedJob = () => worker.get(Scheduler).runJobOnce(SEED_ROLES_JOB);

  async function moderatorOf(marketId: string) {
    const { rows } = await sql.query<{ id: string; seed_version: number }>(
      `SELECT id, seed_version FROM identity.roles
        WHERE market_id = $1 AND scope = 'platform' AND seed_code = 'catalogue-moderator'`,
      [marketId],
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }
  async function keysOf(marketId: string, roleId: string): Promise<string[]> {
    const { rows } = await sql.query<{ permission_key: string }>(
      `SELECT permission_key FROM identity.role_permissions
        WHERE market_id = $1 AND role_id = $2 ORDER BY permission_key`,
      [marketId, roleId],
    );
    return rows.map((r) => r.permission_key);
  }
  async function upgradeRowsOf(marketId: string, roleId: string) {
    const { rows } = await sql.query<{ before: unknown; after: unknown }>(
      `SELECT before, after FROM platform.audit_log
        WHERE market_id = $1 AND target_id = $2 AND action = 'identity.role.seed-applied'
          AND before->>'seedVersion' = '1' AND after->>'seedVersion' = '2'
        ORDER BY occurred_at`,
      [marketId, roleId],
    );
    return rows;
  }

  it("the worker has catalog's keys in its sealed registry before the job can run", () => {
    const registry = worker.get(PermissionRegistry);
    expect(registry.sealed).toBe(true);
    expect(registry.get(EDIT)).toMatchObject({ key: EDIT, scope: 'platform', protected: false });
  });

  it('upgrades a Market seeded at catalogue-moderator version 1 to 2 with the key, in every hosted Market', async () => {
    // Every hosted Market has its roles (first run creates them, if no other file did yet).
    await expect(runSeedJob()).resolves.toEqual({ outcome: 'ran', failedMarkets: [] });

    const earlier = new Map<string, number>();
    for (const code of TEST_MARKETS) {
      const role = await moderatorOf(code);
      earlier.set(code, (await upgradeRowsOf(code, role.id)).length);
      // Put the Market back as the previous build left it: version 1, without the key.
      await sql.query(
        `UPDATE identity.roles SET seed_version = 1 WHERE market_id = $1 AND id = $2`,
        [code, role.id],
      );
      await sql.query(
        `DELETE FROM identity.role_permissions
          WHERE market_id = $1 AND role_id = $2 AND permission_key = $3`,
        [code, role.id, EDIT],
      );
      expect(await keysOf(code, role.id)).toEqual(['identity.seller-access.view']);
    }

    // No Market fails: a worker without catalog's keys would refuse the run as unknown-key.
    await expect(runSeedJob()).resolves.toEqual({ outcome: 'ran', failedMarkets: [] });

    for (const code of TEST_MARKETS) {
      const role = await moderatorOf(code);
      expect(role.seed_version).toBe(2);
      expect(await keysOf(code, role.id)).toEqual([EDIT, 'identity.seller-access.view']);
      const rows = await upgradeRowsOf(code, role.id);
      expect(rows).toHaveLength(earlier.get(code)! + 1);
      expect(rows.at(-1)).toEqual({
        before: { seedVersion: 1 },
        after: { seedVersion: 2, addedKeys: [EDIT], removedKeys: [] },
      });
    }
  });
});
