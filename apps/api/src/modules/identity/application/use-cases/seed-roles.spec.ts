import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { IdentityFakes } from '../../../../../test/support/identity-fakes';
import { realPermissionRegistry } from '../../../../../test/support/permission-registry';
import {
  TEST_MARKETS,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
} from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { MAX_SEED_KEYS_PER_ROW, RoleSeedApplied } from '../../domain/audit';
import { CheckedInRoleSeed } from '../../infrastructure/seed/checked-in-role-seed';
import type { RoleSeed, SeededRole } from '../ports/role-seed';
import type { RoleRepository } from '../ports/seller-team.repository';
import { SeedRoles } from './seed-roles.use-case';

// The seed routine of identity design 5.6 for slice 8a-1, in memory, for both Market fixtures:
// the default roles with their keys, the audited seed-version upgrade of system and default
// roles (Ali 2026-10-08; platform-audit.md 5 and 14), the boot-time key check repeated on every
// run, and convergence. The SQL and the real audit writer are in test/db/role-seed.db-spec.ts.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);

/** The checked-in seed with some roles replaced, as a later build would ship it. */
const seedWith = (change: (role: SeededRole) => SeededRole): RoleSeed => ({
  roles: () => new CheckedInRoleSeed().roles().map(change),
});

describe.each(TEST_MARKETS)('SeedRoles in market %s (identity design 5.6; slice 8a-1)', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', PLATFORM_TENANT_ID);
  const system = testCallContext(market, 'system', 'seed-roles-0001');
  let fakes: IdentityFakes;
  // One id sequence per test, so runs for two Markets never mint the same role id.
  let ids: SequenceIdGenerator;
  let logs: jest.SpyInstance[];

  beforeEach(() => {
    fakes = new IdentityFakes();
    ids = new SequenceIdGenerator(new FixedClock(START));
    logs = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });
  afterEach(() => logs.forEach((spy) => spy.mockRestore()));

  const logged = (msg: string): unknown[] | undefined =>
    logs
      .flatMap((spy) => spy.mock.calls as unknown[][])
      .find((call) => (call[0] as { msg?: string }).msg === msg);

  const seedRoles = (
    seed: RoleSeed = new CheckedInRoleSeed(),
    overrides: { roles?: RoleRepository; audit?: AuditWriter } = {},
  ) => {
    const clock = new FixedClock(START);
    return new SeedRoles(gate, {
      unitOfWork: fakes.unitOfWork,
      roles: overrides.roles ?? fakes.roleRepository,
      seed,
      permissions: realPermissionRegistry(),
      clock,
      ids,
      audit: overrides.audit ?? fakes.audit,
    });
  };
  const roleOf = (scope: string, seedCode: string) =>
    [...fakes.roles.values()].find(
      (r) => r.marketId === market.marketId && r.scope === scope && r.seedCode === seedCode,
    )!;

  it('creates the default roles of 5.6 with their keys, as shared rows (R9), once', async () => {
    await expect(seedRoles().execute(system, {})).resolves.toEqual({
      ok: true,
      value: { created: 12, upgraded: 0 },
    });

    expect(roleOf('platform', 'onboarding-compliance')).toMatchObject({
      kind: 'default',
      sellerId: null,
      seedVersion: 1,
      permissionKeys: [
        'identity.seller-access.approve',
        'identity.seller-access.suspend',
        'identity.seller-access.view',
        'identity.seller-account.create',
      ],
    });
    expect(roleOf('seller', 'store-manager').permissionKeys).toEqual([
      'identity.seller-role.view',
      'identity.team-member.view',
    ]);
    expect(roleOf('seller', 'bookkeeper').permissionKeys).toEqual([]);
    // One identity.role.seeded per created role, as the system, with its kind and version.
    expect(fakes.audits).toHaveLength(12);
    expect(new Set(fakes.audits.map((a) => `${a.action}|${a.actor}|${a.marketId}`))).toEqual(
      new Set([`identity.role.seeded|system|${code}`]),
    );
    expect(
      fakes.audits.filter((a) => (a.after as { kind: string }).kind === 'default'),
    ).toHaveLength(10);

    // A second run, and a run in the other Market, never touch these rows.
    await expect(seedRoles().execute(system, {})).resolves.toEqual({
      ok: true,
      value: { created: 0, upgraded: 0 },
    });
    expect(fakes.audits).toHaveLength(12);
    await seedRoles().execute(testCallContext(other, 'system', 'seed-roles-0002'), {});
    expect([...fakes.roles.values()].filter((r) => r.marketId === market.marketId)).toHaveLength(
      12,
    );
  });

  it('upgrades a default role key by key, with one seed-applied row (Ali 2026-10-08)', async () => {
    await seedRoles().execute(system, {});
    const before = roleOf('seller', 'store-manager');
    fakes.audits.length = 0;
    const v2 = seedWith((role) =>
      role.seedCode === 'store-manager'
        ? {
            ...role,
            seedVersion: 2,
            permissionKeys: ['identity.team-member.view', 'identity.seller-access.view'].slice(
              0,
              1,
            ),
          }
        : role,
    );

    await expect(seedRoles(v2).execute(system, {})).resolves.toEqual({
      ok: true,
      value: { created: 0, upgraded: 1 },
    });

    expect(roleOf('seller', 'store-manager')).toMatchObject({
      id: before.id,
      seedVersion: 2,
      version: before.version + 1,
      permissionKeys: ['identity.team-member.view'],
    });
    expect(fakes.audits).toEqual([
      {
        ...RoleSeedApplied.entry(before.id, {
          before: { seedVersion: 1 },
          after: { seedVersion: 2, addedKeys: [], removedKeys: ['identity.seller-role.view'] },
        }),
        actor: 'system',
        marketId: code,
      },
    ]);
    expect(logged('identity.seed-roles.upgraded')?.[0]).toMatchObject({
      roleId: before.id,
      fromSeedVersion: 1,
      seedVersion: 2,
    });

    // Applied once: the next run finds the role current and writes nothing.
    await expect(seedRoles(v2).execute(system, {})).resolves.toEqual({
      ok: true,
      value: { created: 0, upgraded: 0 },
    });
    expect(fakes.audits).toHaveLength(1);
  });

  it('upgrades a system role: the version only, an audited update, never ON CONFLICT DO NOTHING', async () => {
    await seedRoles().execute(system, {});
    const before = roleOf('platform', 'platform-administrator');
    fakes.audits.length = 0;
    const v2 = seedWith((role) =>
      role.seedCode === 'platform-administrator' ? { ...role, seedVersion: 2 } : role,
    );

    await expect(seedRoles(v2).execute(system, {})).resolves.toMatchObject({
      value: { upgraded: 1 },
    });

    expect(roleOf('platform', 'platform-administrator')).toMatchObject({
      kind: 'system',
      seedVersion: 2,
      permissionKeys: [],
    });
    expect(fakes.audits.map((a) => [a.action, a.targetId, a.before, a.after])).toEqual([
      [
        'identity.role.seed-applied',
        before.id,
        { seedVersion: 1 },
        { seedVersion: 2, addedKeys: [], removedKeys: [] },
      ],
    ]);
  });

  it('never downgrades a role stored at a newer version (an older build running), and warns', async () => {
    await seedRoles(
      seedWith((role) => (role.seedCode === 'viewer' ? { ...role, seedVersion: 3 } : role)),
    ).execute(system, {});
    fakes.audits.length = 0;

    await expect(seedRoles().execute(system, {})).resolves.toEqual({
      ok: true,
      value: { created: 0, upgraded: 0 },
    });

    expect(roleOf('platform', 'viewer').seedVersion).toBe(3);
    expect(fakes.audits).toEqual([]);
    expect(logged('identity.seed-roles.stored-newer')?.[0]).toMatchObject({
      seedCode: 'viewer',
      storedSeedVersion: 3,
      seedVersion: 1,
    });
  });

  it('never changes a stored role of another kind under the same code', async () => {
    await seedRoles().execute(system, {});
    const stored = roleOf('seller', 'bookkeeper');
    fakes.roles.set(stored.id, { ...stored, kind: 'system' });
    fakes.audits.length = 0;

    await seedRoles(
      seedWith((role) => (role.seedCode === 'bookkeeper' ? { ...role, seedVersion: 2 } : role)),
    ).execute(system, {});

    expect(fakes.roles.get(stored.id)!.seedVersion).toBe(1);
    expect(fakes.audits).toEqual([]);
    expect(logged('identity.seed-roles.kind-mismatch')).toBeDefined();
  });

  it.each<[string, (role: SeededRole) => SeededRole, string]>([
    [
      'an unknown key',
      (r) => (r.seedCode === 'finance' ? { ...r, permissionKeys: ['identity.ledger.view'] } : r),
      'unknown-key',
    ],
    [
      'a key of the other scope',
      (r) =>
        r.seedCode === 'finance' ? { ...r, permissionKeys: ['identity.team-member.view'] } : r,
      'wrong-scope',
    ],
    [
      'a protected key (R11)',
      (r) =>
        r.seedCode === 'store-manager'
          ? { ...r, permissionKeys: ['identity.team-member.invite'] }
          : r,
      'protected-key',
    ],
    [
      'a protected key of another module',
      (r) =>
        r.seedCode === 'store-manager'
          ? { ...r, permissionKeys: ['sellers.business-identity.edit'] }
          : r,
      'protected-key',
    ],
  ])('refuses the whole seed with %s, writing nothing', async (_case, change, problem) => {
    await expect(seedRoles(seedWith(change)).execute(system, {})).resolves.toEqual({
      ok: false,
      error: { code: 'seed.invalid' },
    });
    expect(fakes.roles.size).toBe(0);
    expect(fakes.audits).toEqual([]);
    expect(logged('identity.seed-roles.invalid')?.[0]).toMatchObject({ problem });
  });

  it('converges when a concurrent run upgraded the role first', async () => {
    await seedRoles().execute(system, {});
    fakes.audits.length = 0;
    const racing: RoleRepository = {
      ...fakes.roleRepository,
      applySeed: (_m, upgrade) =>
        Promise.reject(new StaleAggregateError('role', upgrade.role.state.id)),
    };

    await expect(
      seedRoles(
        seedWith((role) => (role.seedCode === 'finance' ? { ...role, seedVersion: 2 } : role)),
        { roles: racing },
      ).execute(system, {}),
    ).resolves.toEqual({ ok: true, value: { created: 0, upgraded: 0 } });
    expect(fakes.audits).toEqual([]);
    expect(logged('identity.seed-roles.concurrent')).toBeDefined();
  });

  it('a refused audit row fails the run (PA W5): the unit of the upgrade rolls back', async () => {
    await seedRoles().execute(system, {});
    const refusing: AuditWriter = {
      record: () => Promise.reject(new Error('audit refused')),
    };

    await expect(
      seedRoles(
        seedWith((role) => (role.seedCode === 'finance' ? { ...role, seedVersion: 2 } : role)),
        { audit: refusing },
      ).execute(system, {}),
    ).rejects.toThrow('audit refused');
  });

  it('caps the keys of one row so that the row fits the writer (PA W4)', () => {
    expect(MAX_SEED_KEYS_PER_ROW).toBe(40);
    expect(RoleSeedApplied.after).toMatchObject({
      addedKeys: { kind: 'listOf', max: 40 },
      removedKeys: { kind: 'listOf', max: 40 },
    });
  });

  it('refuses any actor but the system', async () => {
    await expect(
      seedRoles().execute(testCallContext(market, 'anonymous'), {}),
    ).resolves.toMatchObject({ ok: false });
    expect(fakes.roles.size).toBe(0);
  });
});
