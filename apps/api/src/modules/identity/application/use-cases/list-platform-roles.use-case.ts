import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type SealedPermissionCatalogue,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { PLATFORM_ROLE_VIEW } from '../../contracts/permissions';
import type { RoleKind } from '../../domain/role';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { RoleRepository } from '../ports/seller-team.repository';
import {
  grantedRoleOf,
  readActingGrants,
  roleGrantVerdict,
  roleIsInActorsReach,
  type GrantSubject,
} from '../roles/granting';

/** The read takes no parameter: no scope, no seller, no filter (Ali's 10a ruling). */
export type ListPlatformRolesInput = Readonly<Record<string, never>>;

/**
 * One platform role as the catalogue shows it, and nothing more (Ali's 10a ruling): no name or
 * description (`RoleState` has neither; the panel labels a seeded role from `seedCode` through
 * i18n), and no key list (the role editor's detail view, slice 10).
 */
export interface PlatformRoleEntry {
  readonly roleId: Id<'Role'>;
  /** `system` gets a lock in the panel. */
  readonly kind: RoleKind;
  /** The seed code of a system or default role (its label is a translation key); else null. */
  readonly seedCode: string | null;
  /** How many keys the role confers now: every key of the scope for the system role (R3). */
  readonly permissionCount: number;
  /**
   * Whether this actor may give this role now (`GrantPolicy.canGrant` for every key it confers,
   * through `roleGrantVerdict`, the check `AssignAdminRole` and `InviteAdmin` run). A hint only:
   * both commands check again in their own unit. It says nothing about whether the actor holds
   * the assign or invite permission itself.
   */
  readonly grantable: boolean;
}

export interface PlatformRoleCatalogue {
  readonly items: readonly PlatformRoleEntry[];
}

export type ListPlatformRolesFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface ListPlatformRolesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly roles: RoleRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly permissions: Pick<SealedPermissionCatalogue, 'get'>;
}

/**
 * The role catalogue read (identity design 5.3 `identity.platform-role.view`, 8.6 row 6; slice
 * 10a, Ali's ruling 2026-10-09): the platform roles of the context Market with, per role, whether
 * the actor may grant it. Rule `permissions [identity.platform-role.view]`, so a seller-side or
 * customer actor is refused by the gate. One read-only unit (ADR-0025: no transaction):
 *
 * 1. The actor first, as the commands read it (`readActingGrants` with the view key): an active,
 *    verified admin still holding the key, else `access.denied` before any role is read.
 * 2. Then the Market's platform roles (`RoleRepository.platformRoles`, which takes no scope:
 *    the seller scope is not reachable through this read). Each is also checked to be in the
 *    actor's reach, so a row that is not a platform role of this Market is never shown.
 * 3. Per role, `permissionCount` is the size of what it confers (`grantedRoleOf`, the one
 *    resolver) and `grantable` is `roleGrantVerdict`: the same function the assign, invite,
 *    re-send and acceptance checks call, never a second implementation.
 *
 * Slice 10 extends this read with the name, the seller scope and the key detail.
 */
export class ListPlatformRoles extends UseCase<
  ListPlatformRolesInput,
  PlatformRoleCatalogue,
  ListPlatformRolesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.list-platform-roles',
    rule: { kind: 'permissions', allOf: [PLATFORM_ROLE_VIEW.key] },
  };

  readonly #logger = new Logger('ListPlatformRoles');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ListPlatformRolesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ListPlatformRolesInput,
  ): Promise<Result<PlatformRoleCatalogue, ListPlatformRolesFailure>> {
    const result = await this.list(context, input);
    // Codes and counts only: never a key, a role's name or anything personal.
    this.#logger.log({
      msg: 'identity.list-platform-roles',
      outcome: result.ok ? 'platform-roles.listed' : result.error.code,
      ...(result.ok
        ? {
            roles: result.value.items.length,
            grantable: result.value.items.filter((role) => role.grantable).length,
          }
        : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async list(
    context: CallContext,
    input: ListPlatformRolesInput,
  ): Promise<Result<PlatformRoleCatalogue, ListPlatformRolesFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    // A closed input, also for a caller that is not the controller: no parameter selects a
    // scope, a seller or anything else.
    const unknown = Object.keys(input ?? {});
    if (unknown.length > 0) {
      return err({
        code: 'validation.failed',
        fields: unknown.sort().map((path) => ({ path, code: 'unknown' })),
      });
    }
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin', sellerId: null };
    return this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<PlatformRoleCatalogue, ListPlatformRolesFailure>> => {
        // The actor first (Mohammad's 8c nit): refused before any role is read.
        const acting = await readActingGrants(
          this.deps,
          market,
          self,
          [],
          [PLATFORM_ROLE_VIEW.key],
        );
        if (acting === null) return err({ code: 'access.denied' });
        const roles = await this.deps.roles.platformRoles(market);
        const items = roles
          .filter((role) => roleIsInActorsReach(role, self))
          .map((role): PlatformRoleEntry => ({
            roleId: role.state.id,
            kind: role.state.kind,
            seedCode: role.state.seedCode,
            permissionCount: grantedRoleOf(role, this.deps.effectiveKeys).effectiveKeys.size,
            grantable: roleGrantVerdict(acting.actor, role, this.deps).ok,
          }));
        return ok({ items });
      },
      { readOnly: true },
    );
  }
}
