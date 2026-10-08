import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { RoleSeeded } from '../../domain/audit';
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
  readonly audit: AuditWriter;
}

/**
 * The seed routine of identity design 5.6 for the system roles (slice 5). Rule `system`, run per
 * hosted Market at worker start (`identity.seed-roles`, `runAtStart`) and then daily. Roles
 * carry `marketId` (R9), so rows cannot come from a migration (I9). For each system role of the
 * checked-in seed whose scope has none in this Market, one unit creates it; a concurrent or
 * repeated run converges on the unique keys (data design 8.3) and creates nothing. A system role
 * is never changed: it stores no keys (R3). Each creation writes `identity.role.seeded` in its
 * unit (slice 6b; `platform-audit.md` 5): a run that creates nothing writes nothing, and roles
 * seeded before 6b get no row (no backfill). Default roles and their newer versions join with
 * slice 8a-1. Each creation is also logged with ids and codes only.
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
        if (!(await this.deps.roles.addSeeded(market, role))) return ok(null);
        // In the unit of the change; a refusal throws, so the role is not created either.
        await this.deps.audit.record(
          context,
          RoleSeeded.entry(role.state.id, {
            after: {
              scope: role.state.scope,
              kind: role.state.kind,
              seedVersion: seeded.seedVersion,
            },
          }),
        );
        return ok(role);
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
