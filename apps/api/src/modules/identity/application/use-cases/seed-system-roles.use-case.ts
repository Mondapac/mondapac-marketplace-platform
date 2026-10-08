import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { Role } from '../../domain/role';
import type { RoleSeed } from '../ports/role-seed';
import type { RoleRepository } from '../ports/seller-team.repository';

export interface SeedSystemRolesOutput {
  /** System roles created by this run; 0 once the Market is seeded. */
  readonly created: number;
}

export type SeedSystemRolesFailure = { readonly code: 'access.denied' };

export interface SeedSystemRolesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly roles: RoleRepository;
  readonly seed: RoleSeed;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * The seed routine of identity design 5.6 for the system roles (slice 5). Rule `system`, run per
 * hosted Market at worker start (`identity.seed-roles`, `runAtStart`) and then daily. Roles
 * carry `marketId` (R9), so rows cannot come from a migration (I9). For each system role of the
 * checked-in seed whose scope has none in this Market, one unit creates it; a concurrent or
 * repeated run converges on the unique keys (data design 8.3) and creates nothing. A system role
 * is never changed: it stores no keys (R3). Default roles, their newer versions and the audit
 * row per change join with slice 8a and the audit writer (slice 6); until then each creation is
 * logged with ids and codes only.
 */
export class SeedSystemRoles extends UseCase<
  Record<string, never>,
  SeedSystemRolesOutput,
  SeedSystemRolesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.seed-system-roles',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SeedSystemRoles');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SeedSystemRolesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SeedSystemRolesOutput, SeedSystemRolesFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    let created = 0;
    for (const seeded of this.deps.seed.roles()) {
      if (seeded.kind !== 'system') continue;
      const done = await this.deps.unitOfWork.run(market, async () => {
        if ((await this.deps.roles.findSystemRole(market, seeded.scope)) !== null) return ok(null);
        const role = Role.seedSystem({
          id: this.deps.ids.next<'Role'>(),
          marketId: market.marketId,
          scope: seeded.scope,
          seedCode: seeded.seedCode,
          seedVersion: seeded.seedVersion,
          now: this.deps.clock.now(),
        });
        return ok((await this.deps.roles.addSeeded(market, role)) ? role : null);
      });
      if (done.ok && done.value !== null) {
        created += 1;
        this.#logger.log({
          msg: 'identity.seed-system-roles.created',
          roleId: done.value.state.id,
          scope: seeded.scope,
          seedCode: seeded.seedCode,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
      }
    }
    return ok({ created });
  }
}
