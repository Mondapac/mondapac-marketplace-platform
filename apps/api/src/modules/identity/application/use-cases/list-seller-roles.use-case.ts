import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type SealedPermissionCatalogue,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  SELLER_ROLE_DELETE,
  SELLER_ROLE_EDIT,
  SELLER_ROLE_VIEW,
} from '../../contracts/permissions';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { RoleAssignmentRepository, RoleRepository } from '../ports/seller-team.repository';
import { isActingAsSession } from '../sellers/access-decision-reads';
import { readActingGrants, type GrantSubject } from '../roles/granting';
import { buildRoleCatalogue, type RoleCatalogue } from '../roles/role-catalogue';

/** The read takes no parameter: the seller comes from the actor, never from input (R6). */
export type ListSellerRolesInput = Readonly<Record<string, never>>;

/** The seller's roles and the keys of the seller scope (slice 10). */
export type SellerRoleCatalogue = RoleCatalogue;

export type ListSellerRolesFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface ListSellerRolesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly roles: RoleRepository;
  readonly assignments: Pick<RoleAssignmentRepository, 'heldRoles'>;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly permissions: Pick<SealedPermissionCatalogue, 'get' | 'list'>;
}

/**
 * The seller side of the role catalogue (identity design 5.3 `identity.seller-role.view`, 8.6 row
 * 6; slice 10): the roles a seller can give its team, which are the Market's shared system and
 * default seller roles and the seller's **own** custom roles, with the same entry shape,
 * per-key `grantable` and action hints as the platform read, built by the same function. Rule
 * `permissions [identity.seller-role.view]`, so an admin or a customer is refused by the gate.
 *
 * The seller is the actor's (`ActorContext.sellerId`, R6): the read takes no parameter, and
 * another seller's custom role is never read (the repository takes the seller id as a required
 * argument). An acting-as session (SEL-08) is refused. One read-only unit (ADR-0025): the actor
 * is re-read first (`readActingGrants` with the view key), before any role is read.
 */
export class ListSellerRoles extends UseCase<
  ListSellerRolesInput,
  SellerRoleCatalogue,
  ListSellerRolesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.list-seller-roles',
    rule: { kind: 'permissions', allOf: [SELLER_ROLE_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('ListSellerRoles');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ListSellerRolesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ListSellerRolesInput,
  ): Promise<Result<SellerRoleCatalogue, ListSellerRolesFailure>> {
    const result = await this.list(context, input);
    // Codes and counts only: never a key, a role's name or anything personal.
    this.#logger.log({
      msg: 'identity.list-seller-roles',
      outcome: result.ok ? 'seller-roles.listed' : result.error.code,
      ...(result.ok ? { roles: result.value.items.length } : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async list(
    context: CallContext,
    input: ListSellerRolesInput,
  ): Promise<Result<SellerRoleCatalogue, ListSellerRolesFailure>> {
    const { market, actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null ||
      isActingAsSession(actor)
    ) {
      return err({ code: 'access.denied' });
    }
    const unknown = Object.keys(input ?? {});
    if (unknown.length > 0) {
      return err({
        code: 'validation.failed',
        fields: unknown.sort().map((path) => ({ path, code: 'unknown' })),
      });
    }
    const sellerId = actor.sellerId;
    const self: GrantSubject = { accountId: actor.accountId, population: 'seller', sellerId };
    return this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<SellerRoleCatalogue, ListSellerRolesFailure>> => {
        const acting = await readActingGrants(this.deps, market, self, [], [SELLER_ROLE_VIEW.key]);
        if (acting === null) return err({ code: 'access.denied' });
        const roles = await this.deps.roles.sellerRoles(market, sellerId);
        const held = await this.deps.assignments.heldRoles(
          market,
          roles.map((role) => role.state.id),
        );
        return ok(
          buildRoleCatalogue({
            scope: 'seller',
            actor: acting.actor,
            subject: self,
            roles,
            held,
            editKey: SELLER_ROLE_EDIT.key,
            deleteKey: SELLER_ROLE_DELETE.key,
            deps: this.deps,
          }),
        );
      },
      { readOnly: true },
    );
  }
}
