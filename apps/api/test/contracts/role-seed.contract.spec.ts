import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson, encodeAuditFields } from '@mondapac/shared-kernel';
import {
  SEED_APPLIED_OVERHEAD_BYTES,
  SEED_KEYS_BUDGET_BYTES,
  seedKeysCost,
} from '../../src/modules/identity/application/roles/role-seed-budget';
import { checkRoleSeedKeys } from '../../src/modules/identity/application/roles/role-seed-keys';
import { RoleSeedApplied, MAX_SEED_KEYS_PER_ROW } from '../../src/modules/identity/domain/audit';
import {
  checkRoleSeed,
  CheckedInRoleSeed,
} from '../../src/modules/identity/infrastructure/seed/checked-in-role-seed';
import { MAX_AUDIT_SIDE_BYTES } from '../../src/platform/audit/audit-writer';
import { MAX_PERMISSION_KEY_LENGTH } from '../../src/platform/authz';
import { PERMISSION_KEY_PATTERN } from '../../src/platform/authz/access-rule';
import { realPermissionRegistry } from '../support/permission-registry';
import { keysCosting, keysWithin } from '../support/seed-key-fixtures';

// The append-only snapshot of the role seed (identity slice 8a-1; Mohammad 2, Hassan M-1).
// `identity.role.seeded` names a default role's keys only by its seed version, so the keys of
// every version that ever shipped must stay resolvable: role-seed.snapshot.json holds one entry
// per `scope:seedCode@seedVersion` with its kind and sorted keys, and entries are only ever
// appended. When a seed file changes a role, raise its `seedVersion` and append the new entry
// as the failure prints it, together with its digest in PINNED below. Never edit or remove an
// entry or a pin: the pins make a changed or removed entry fail here, and any change to them
// shows in review.
//
// Also the byte budget of a seeded role's keys (role-seed-budget.ts; Ali's ruling on Mohammad's
// review): with both lists of a `seed-applied` row filled to the budget, or to 40 keys, the row
// fits the audit writer's 4 KB per side, and one byte over the budget is refused. "Removed" is a
// subset of a previous version that passed the same budget; if the budget formula changes, the
// older entries of the snapshot must be re-checked against it.

const SNAPSHOT = path.join(__dirname, 'role-seed.snapshot.json');

interface SnapshotEntry {
  /** `scope:seedCode@seedVersion`. */
  readonly entry: string;
  readonly kind: string;
  /** Sorted. */
  readonly permissionKeys: readonly string[];
}

/** sha256 of each entry as written when it was appended (key order: entry, kind, keys). */
const PINNED: readonly (readonly [string, string])[] = [
  [
    'platform:platform-administrator@1',
    '3e2f4e04cef985ac1a55acf6153772f8faa83f99849e230e9a1c2f3286b933dc',
  ],
  [
    'platform:onboarding-compliance@1',
    '885abe4944ed0c5d21988ded9c539478aa3b0150fc02edb298a03c20e0114645',
  ],
  [
    'platform:catalogue-moderator@1',
    'ea0fc147ed7c5d64d0b7d62774930191770fd782b51cb78e6fa9d7a407be67d1',
  ],
  [
    'platform:operations-support@1',
    '638d6d340ea216086b3c4d3460d0b2a00ca1d58b99d93a0b5922434c9256d702',
  ],
  ['platform:finance@1', '4967276856850ff7c2de9b677fe938712922e0bba9045880af09e23be1cd335d'],
  ['platform:viewer@1', '8529eb9b694c60ed7879e27105ae23ee9dff172e865cc0a01dddae14009df53f'],
  ['seller:seller-owner@1', '1160010ae76557449e8291c6fe316adf33687fd539eb6e7c8d2c2717141b27fd'],
  ['seller:store-manager@1', 'b1980d6c20c940e92c182d999d540f7c0a3879708be7a1cff2519a24aac5f6be'],
  ['seller:order-fulfilment@1', 'd3597f6dba059fcb84cb8df6da6c674166669b3055c5f347318776c19115b415'],
  ['seller:catalogue-stock@1', '1083a046a4c4e67ab9f50c79b637ef85f4c0e8a100910b74f5ba92c6313d6f57'],
  ['seller:customer-service@1', '0a8d79bee80e8e8a81f42f7a557b63be0b6b3907596d1a0ad3116efef70d1da2'],
  ['seller:bookkeeper@1', 'f06666c7b62e7192c4a7e8e50e42c9fa3667c3a34774d87eb1b3d6dcf8b1fd52'],
  [
    'platform:onboarding-compliance@2',
    'ac191a2f8d0a212f1d1999406817e86cab41617d1092a423eba1672e087af7a5',
  ],
  [
    'platform:catalogue-moderator@2',
    '47ee8bdbc5ea862063818cc7663efe7631b4bf913f8b56abb1e74271d22d3267',
  ],
  ['platform:viewer@2', '9999ab667e19eb83f2cb21adfdbe6d25e9be8ddf3ba59f4ec8045cdfcd1c9624'],
  [
    'platform:onboarding-compliance@3',
    'b31c2918f2f3f41708d6378dd8b5b2eaf9255ec4965753b9f3b455ce38c170a5',
  ],
  [
    'platform:catalogue-moderator@3',
    'b97a599d3c30e10164e823315bed5dccedaf162751c9371e3ec856dbe64c5d92',
  ],
  [
    'platform:operations-support@2',
    '46633d99b07522bc151e6267e46ec931da8b087ba5fc8df38bc3e4247e8c3e20',
  ],
  ['platform:finance@2', '2882643b9e6be34ee2884165f3e48f46341364e707176484f3f8a79855e210eb'],
  ['seller:store-manager@2', 'f9128aa75bc5b4cf8f57cd9998be691dd3bf9335eb462ae45221e5e68c28cde1'],
  ['seller:catalogue-stock@2', '7d12fba91284c1d81f40920ae6b7baed41936cd7f5b64ca187a86d663bac87ac'],
  ['seller:customer-service@2', 'e2f54ecb07a1871755288e69800a11ee227172ccf480da62568d3b9b842d8527'],
];

const ENTRY = /^(platform|seller):([a-z][a-z0-9-]*)@([1-9][0-9]*)$/;

const digestOf = (entry: SnapshotEntry): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        entry: entry.entry,
        kind: entry.kind,
        permissionKeys: entry.permissionKeys,
      }),
    )
    .digest('hex');

const CHECKED_IN = new CheckedInRoleSeed().roles();
const VIEWER = CHECKED_IN.find((role) => role.seedCode === 'viewer')!;

const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as SnapshotEntry[];

/** The snapshot entry of the current seed's role. */
function currentEntries(): SnapshotEntry[] {
  return new CheckedInRoleSeed().roles().map((role) => ({
    entry: `${role.scope}:${role.seedCode}@${role.seedVersion}`,
    kind: role.kind,
    permissionKeys: [...role.permissionKeys].sort(),
  }));
}

describe('the append-only role seed snapshot (slice 8a-1; Mohammad 2, Hassan M-1)', () => {
  it('holds well-formed, distinct entries with sorted keys', () => {
    const names = snapshot.map((e) => e.entry);
    expect(names.filter((name) => !ENTRY.test(name))).toEqual([]);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of snapshot) {
      expect([entry.entry, entry.permissionKeys]).toEqual([
        entry.entry,
        [...new Set(entry.permissionKeys)].sort(),
      ]);
    }
  });

  it('keeps every pinned entry, unchanged and in order: entries are only appended', () => {
    expect(snapshot.length).toBeGreaterThanOrEqual(PINNED.length);
    expect(snapshot.slice(0, PINNED.length).map((entry) => [entry.entry, digestOf(entry)])).toEqual(
      PINNED.map(([entry, digest]) => [entry, digest]),
    );
    // Every entry is pinned: an appended entry adds its pin in the same change.
    expect(snapshot.map((entry) => [entry.entry, digestOf(entry)])).toEqual(
      PINNED.map(([entry, digest]) => [entry, digest]),
    );
  });

  it('keeps each role versions 1 to n, with no gap', () => {
    const versions = new Map<string, number[]>();
    for (const { entry } of snapshot) {
      const [, scope, code, version] = ENTRY.exec(entry)!;
      const role = `${scope}:${code}`;
      versions.set(role, [...(versions.get(role) ?? []), Number(version)]);
    }
    for (const [role, list] of versions) {
      expect([role, list]).toEqual([role, list.map((_, n) => n + 1)]);
    }
  });

  it("matches the current seed: each role's entry at its version, and no version goes down", () => {
    const byName = new Map(snapshot.map((e) => [e.entry, e]));
    const latest = new Map<string, number>();
    for (const { entry } of snapshot) {
      const [, scope, code, version] = ENTRY.exec(entry)!;
      const role = `${scope}:${code}`;
      latest.set(role, Math.max(latest.get(role) ?? 0, Number(version)));
    }
    for (const current of currentEntries()) {
      // Missing: append this entry (raise the version if the role changed).
      expect(byName.get(current.entry)).toEqual(current);
      const [, scope, code, version] = ENTRY.exec(current.entry)!;
      expect([current.entry, Number(version)]).toEqual([
        current.entry,
        latest.get(`${scope}:${code}`),
      ]);
    }
  });
});

describe('the byte budget of a seeded role fits the audit writer (Ali on Mohammad, Hassan L-1)', () => {
  /** The canonical JSON bytes of a `seed-applied` after, through the writer's own encoding. */
  function bytesOf(addedKeys: string[], removedKeys: string[]): number {
    const encoded = encodeAuditFields(
      RoleSeedApplied.after,
      // The column is a PostgreSQL integer: its largest value is the longest version.
      { seedVersion: 2_147_483_647, addedKeys, removedKeys },
      { isKnownPermissionKey: () => true },
    );
    if (!encoded.ok) throw new Error(`does not encode: ${encoded.error.problem}`);
    const text = canonicalJson(encoded.value);
    if (!text.ok) throw new Error('no canonical JSON');
    return Buffer.byteLength(text.value, 'utf8');
  }

  it('measures the overhead from the encoder and splits the rest in two', () => {
    expect(SEED_APPLIED_OVERHEAD_BYTES).toBe(bytesOf([], []));
    expect(SEED_KEYS_BUDGET_BYTES).toBe(
      Math.floor((MAX_AUDIT_SIDE_BYTES - SEED_APPLIED_OVERHEAD_BYTES) / 2),
    );
  });

  it('both lists filled to the exact byte budget fit 4 KB', () => {
    const added = keysCosting(SEED_KEYS_BUDGET_BYTES, 'a');
    const removed = keysCosting(SEED_KEYS_BUDGET_BYTES, 'r');
    expect([seedKeysCost(added), seedKeysCost(removed)]).toEqual([
      SEED_KEYS_BUDGET_BYTES,
      SEED_KEYS_BUDGET_BYTES,
    ]);
    expect(Math.max(...added.map((k) => k.length))).toBe(MAX_PERMISSION_KEY_LENGTH);
    for (const key of [...added, ...removed]) expect(key).toMatch(PERMISSION_KEY_PATTERN);
    expect(() =>
      checkRoleSeed([
        ...CHECKED_IN.filter((r) => r !== VIEWER),
        { ...VIEWER, permissionKeys: added },
      ]),
    ).not.toThrow();

    expect(bytesOf(added, removed)).toBeLessThanOrEqual(MAX_AUDIT_SIDE_BYTES);
  });

  it('both lists filled to 40 keys, as long as the budget allows, fit 4 KB', () => {
    const added = keysWithin(SEED_KEYS_BUDGET_BYTES, MAX_SEED_KEYS_PER_ROW, 'a');
    const removed = keysWithin(SEED_KEYS_BUDGET_BYTES, MAX_SEED_KEYS_PER_ROW, 'r');
    expect([added.length, seedKeysCost(added) <= SEED_KEYS_BUDGET_BYTES]).toEqual([
      MAX_SEED_KEYS_PER_ROW,
      true,
    ]);

    expect(bytesOf(added, removed)).toBeLessThanOrEqual(MAX_AUDIT_SIDE_BYTES);
  });

  it('refuses one byte over the budget at boot: checkRoleSeed and checkRoleSeedKeys', () => {
    const over = keysCosting(SEED_KEYS_BUDGET_BYTES + 1, 'a');
    expect(seedKeysCost(over)).toBe(SEED_KEYS_BUDGET_BYTES + 1);
    const roles = [...CHECKED_IN.filter((r) => r !== VIEWER), { ...VIEWER, permissionKeys: over }];

    expect(() => checkRoleSeed(roles)).toThrow(/keys-too-large/);
    expect(() => checkRoleSeedKeys(roles, realPermissionRegistry())).toThrow(
      expect.objectContaining({ problem: 'keys-too-large', seedCode: 'viewer' }) as Error,
    );
  });

  it('every key the registry declares is within the stored column limit of 128', () => {
    expect(MAX_PERMISSION_KEY_LENGTH).toBe(128);
    for (const declaration of realPermissionRegistry().list()) {
      expect(declaration.key.length).toBeLessThanOrEqual(MAX_PERMISSION_KEY_LENGTH);
    }
  });
});
