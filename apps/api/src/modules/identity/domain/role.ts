import type { Id, MarketId, Population, Temporal } from '@mondapac/shared-kernel';

/** The two scopes of a role (R2): there is no customer scope. */
export const ROLE_SCOPES = ['platform', 'seller'] as const;
export type RoleScope = (typeof ROLE_SCOPES)[number];

/** `system` (R3), `default` (seeded, slice 8a) and `custom` (slice 10, 11). */
export const ROLE_KINDS = ['system', 'default', 'custom'] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

/** A seed code: the `roles_seed_code_check` of the data design (3.9). */
const SEED_CODE = /^[a-z][a-z0-9-]*$/;
const MAX_SEED_CODE_LENGTH = 64;

/**
 * A permission key's shape (platform-foundations 6.1; the CHECK on `role_permissions`). The
 * domain checks only the shape: whether the registry declares a key, and in which scope, is
 * checked by the seed routine and the role editor, and an unknown stored key is dropped when
 * keys are resolved (R7).
 */
const PERMISSION_KEY = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2}$/;

/** The stored keys in their canonical form: unique, sorted, frozen; or null when malformed. */
function canonicalKeys(keys: readonly string[]): readonly string[] | null {
  if (!Array.isArray(keys)) return null;
  if (keys.some((key) => typeof key !== 'string' || !PERMISSION_KEY.test(key))) return null;
  const sorted = [...new Set(keys)].sort();
  return sorted.length === keys.length ? Object.freeze(sorted) : null;
}

/**
 * The state of a {@link Role} (identity design 2.1; data design 3.9). The keys of a default role
 * are stored from slice 8a-1; the name of a custom role joins with the role editor (slice 10). A
 * system role has neither: it holds every key of its scope by definition (R3).
 */
export interface RoleState {
  readonly id: Id<'Role'>;
  readonly marketId: MarketId;
  readonly scope: RoleScope;
  readonly kind: RoleKind;
  /** Set if and only if the kind is not `custom`. */
  readonly seedCode: string | null;
  readonly seedVersion: number | null;
  /** Set only on a seller-scope custom role (R9). */
  readonly sellerId: Id<'Seller'> | null;
  /** The stored keys (`role_permissions`), unique and sorted; always empty for a system role. */
  readonly permissionKeys: readonly string[];
  readonly version: number;
  readonly createdAt: Temporal.Instant;
}

/** What applying a newer seed version changed: the keys added and removed (R5, PA 5). */
export interface SeedUpgrade {
  readonly role: Role;
  readonly fromSeedVersion: number;
  readonly addedKeys: readonly string[];
  readonly removedKeys: readonly string[];
}

/** A state that breaks an invariant of 2.1 or 5.5: a bug of the caller or a corrupt row. */
export class RoleInvariantError extends Error {
  override readonly name = 'RoleInvariantError';
  constructor(
    readonly invariant:
      | 'scope'
      | 'kind'
      | 'seed'
      | 'seller'
      | 'keys'
      | 'version'
      | 'population'
      | 'market'
      | 'founding-role'
      | 'seed-upgrade',
  ) {
    super(`Role invariant broken: ${invariant}`);
  }
}

/** The scope a population's role must have (R2); a customer has none. */
export function scopeOfPopulation(population: Population): RoleScope | null {
  switch (population) {
    case 'seller':
      return 'seller';
    case 'admin':
      return 'platform';
    case 'customer':
      return null;
  }
}

/**
 * The `Role` aggregate (identity design 2.1, 2.3, 5.6). Slice 5 builds the system roles: seeded
 * rows, one per scope and Market, that hold every key of their scope by definition (R3), so
 * their keys are not stored and a new module's keys reach them with no edit. Read-only to every
 * actor; only the seed routine creates them.
 */
export class Role {
  readonly #state: RoleState;

  private constructor(
    state: RoleState,
    /** The version read from the store; null for a role not stored yet. */
    readonly persistedVersion: number | null,
  ) {
    if (!(ROLE_SCOPES as readonly string[]).includes(state.scope)) {
      throw new RoleInvariantError('scope');
    }
    if (!(ROLE_KINDS as readonly string[]).includes(state.kind)) {
      throw new RoleInvariantError('kind');
    }
    const seeded = state.kind !== 'custom';
    if (
      seeded !== (state.seedCode !== null) ||
      seeded !== (state.seedVersion !== null) ||
      (state.seedCode !== null &&
        (state.seedCode.length > MAX_SEED_CODE_LENGTH || !SEED_CODE.test(state.seedCode))) ||
      (state.seedVersion !== null &&
        (!Number.isInteger(state.seedVersion) || state.seedVersion < 1))
    ) {
      throw new RoleInvariantError('seed');
    }
    if ((state.scope === 'seller' && state.kind === 'custom') !== (state.sellerId !== null)) {
      throw new RoleInvariantError('seller');
    }
    const keys = canonicalKeys(state.permissionKeys);
    if (keys === null || (state.kind === 'system' && keys.length > 0)) {
      throw new RoleInvariantError('keys');
    }
    if (!Number.isInteger(state.version) || state.version < 1) {
      throw new RoleInvariantError('version');
    }
    this.#state = Object.freeze({ ...state, permissionKeys: keys });
  }

  /** A system role created by the seed routine (5.6): the first holder of its scope gets it. */
  static seedSystem(input: {
    readonly id: Id<'Role'>;
    readonly marketId: MarketId;
    readonly scope: RoleScope;
    readonly seedCode: string;
    readonly seedVersion: number;
    readonly now: Temporal.Instant;
  }): Role {
    const { id, marketId, scope, seedCode, seedVersion, now } = input;
    return new Role(
      {
        id,
        marketId,
        scope,
        kind: 'system',
        seedCode,
        seedVersion,
        sellerId: null,
        permissionKeys: [],
        version: 1,
        createdAt: now,
      },
      null,
    );
  }

  /**
   * A default role created by the seed routine (5.6; slice 8a-1): a shared row of its scope and
   * Market (no seller, R9) with the keys of its seed file. No use case of a seller or an admin
   * changes it; only a newer seed version does ({@link applySeed}, R10).
   */
  static seedDefault(input: {
    readonly id: Id<'Role'>;
    readonly marketId: MarketId;
    readonly scope: RoleScope;
    readonly seedCode: string;
    readonly seedVersion: number;
    readonly permissionKeys: readonly string[];
    readonly now: Temporal.Instant;
  }): Role {
    const { id, marketId, scope, seedCode, seedVersion, permissionKeys, now } = input;
    return new Role(
      {
        id,
        marketId,
        scope,
        kind: 'default',
        seedCode,
        seedVersion,
        sellerId: null,
        permissionKeys,
        version: 1,
        createdAt: now,
      },
      null,
    );
  }

  /** A role read from the store. Checks the invariants again. */
  static restore(state: RoleState): Role {
    return new Role(state, state.version);
  }

  get state(): RoleState {
    return this.#state;
  }

  get isSystem(): boolean {
    return this.#state.kind === 'system';
  }

  /**
   * Applies a newer version of this role's seed (5.6; Ali 2026-10-08, PA 14 condition 3): the
   * stored keys become the seed's, key by key, and the version steps. Only a seeded role (system
   * or default) and only a strictly newer version: a custom role changes only through the role
   * editor (R10), and an older or equal version is never applied. A system role stays without
   * stored keys (R3). The persisted version is kept, so the store updates at the version read.
   */
  applySeed(seed: {
    readonly seedVersion: number;
    readonly permissionKeys: readonly string[];
  }): SeedUpgrade {
    const state = this.#state;
    if (state.kind === 'custom' || state.seedVersion === null) {
      throw new RoleInvariantError('seed-upgrade');
    }
    if (!Number.isInteger(seed.seedVersion) || seed.seedVersion <= state.seedVersion) {
      throw new RoleInvariantError('seed-upgrade');
    }
    const next = canonicalKeys(seed.permissionKeys);
    if (next === null) throw new RoleInvariantError('keys');
    const before = new Set(state.permissionKeys);
    const after = new Set(next);
    const role = new Role(
      { ...state, seedVersion: seed.seedVersion, permissionKeys: next, version: state.version + 1 },
      this.persistedVersion,
    );
    return {
      role,
      fromSeedVersion: state.seedVersion,
      addedKeys: Object.freeze(next.filter((key) => !before.has(key))),
      removedKeys: Object.freeze(state.permissionKeys.filter((key) => !after.has(key))),
    };
  }
}

/** The state of a {@link RoleAssignment} (identity design 2.1; data design 3.9). */
export interface RoleAssignmentState {
  readonly id: Id<'RoleAssignment'>;
  readonly marketId: MarketId;
  readonly accountId: Id<'Account'>;
  readonly roleId: Id<'Role'>;
  /** Null for a founding assignment (5.5). */
  readonly assignedByAccountId: Id<'Account'> | null;
  readonly assignedAt: Temporal.Instant;
  readonly version: number;
}

/**
 * The `RoleAssignment` aggregate (identity design 2.1, 2.3): the one role of an account in
 * Phase 2 (a database rule). The role's scope matches the account's population, and a customer
 * never has one (R2). Slice 5 builds the founding assignment of 5.5 only: the creation of a
 * scope, not a grant under R3, so no assigner, no audit row at self-registration and no event
 * (`seller-registered` names the owner).
 */
export class RoleAssignment {
  readonly #state: RoleAssignmentState;

  private constructor(
    state: RoleAssignmentState,
    readonly persistedVersion: number | null,
  ) {
    if (!Number.isInteger(state.version) || state.version < 1) {
      throw new RoleInvariantError('version');
    }
    this.#state = Object.freeze({ ...state });
  }

  /**
   * The founding assignment (5.5): the system role of the account's scope, given by the use case
   * that creates the scope (self-registration in slice 5).
   */
  static found(input: {
    readonly id: Id<'RoleAssignment'>;
    readonly account: {
      readonly id: Id<'Account'>;
      readonly marketId: MarketId;
      readonly population: Population;
    };
    readonly role: Role;
    readonly now: Temporal.Instant;
  }): RoleAssignment {
    const { id, account, role, now } = input;
    const scope = scopeOfPopulation(account.population);
    if (scope === null || scope !== role.state.scope) {
      throw new RoleInvariantError('population');
    }
    if (account.marketId !== role.state.marketId) {
      throw new RoleInvariantError('market');
    }
    if (!role.isSystem) {
      throw new RoleInvariantError('founding-role');
    }
    return new RoleAssignment(
      {
        id,
        marketId: account.marketId,
        accountId: account.id,
        roleId: role.state.id,
        assignedByAccountId: null,
        assignedAt: now,
        version: 1,
      },
      null,
    );
  }

  /** An assignment read from the store. */
  static restore(state: RoleAssignmentState): RoleAssignment {
    return new RoleAssignment(state, state.version);
  }

  get state(): RoleAssignmentState {
    return this.#state;
  }
}
