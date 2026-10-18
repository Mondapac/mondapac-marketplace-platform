import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_TYPE_EDIT } from '../../contracts/permissions';
import { TypeDeactivatedAudit } from '../../domain/audit';
import { CertificationTypeDeactivated } from '../../domain/events';
import { deactivateType, type TypeStatusProblem } from '../../domain/registry';
import {
  adminOf,
  invalid,
  parseTypeId,
  registryFailure,
  versionIn,
  type RegistryDependencies,
  type ValidationFailure,
} from '../registry/registry.shared';

export interface TypeDeactivateInput {
  readonly typeId: unknown;
  readonly version: unknown;
}

export interface TypeDeactivateOutput {
  readonly typeId: string;
  readonly status: 'inactive';
  readonly version: number;
}

export type TypeDeactivateFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'type.not-found' }
  | { readonly code: 'conflict.stale' }
  | TypeStatusProblem
  | ValidationFailure;

/**
 * `types.deactivate` (certification design 3.6; CERT-03; AC 19): `active` → `inactive` at once, no
 * second admin (it only tightens). Sellers can no longer add a certificate of the type (create,
 * submit and approve of a never-approved record refuse `type.inactive`); every approved certificate
 * keeps counting until its own boundary, since `evaluateClaims` does not read the type's status.
 * One unit: the status under the version, `certification.type.deactivated`,
 * `certification-type-deactivated.v1`. Rule: key `certification.type.edit` (protected).
 */
export class TypeDeactivate extends UseCase<
  TypeDeactivateInput,
  TypeDeactivateOutput,
  TypeDeactivateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.type-deactivate',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_TYPE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RegistryDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: TypeDeactivateInput,
  ): Promise<Result<TypeDeactivateOutput, TypeDeactivateFailure>> {
    if (adminOf(context, { write: true }) === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const typeId = parseTypeId(input.typeId);
    if (typeId === null) return invalid('typeId', 'format');
    const version = versionIn(input.version);
    if (!version.ok) return err(version.error);
    const { deps } = this;
    const { market } = context;
    const now = deps.clock.now();
    return deps.unitOfWork
      .run<TypeDeactivateOutput, TypeDeactivateFailure>(market, async () => {
        const type = await deps.registry.type(market, typeId);
        if (type === null) return err({ code: 'type.not-found' } as const);
        const next = deactivateType(type.status);
        if (!next.ok) return err(next.error);
        if (type.version !== version.value) return err({ code: 'conflict.stale' } as const);
        await deps.registry.setTypeStatus(market, typeId, 'inactive', version.value);
        await deps.audit.record(
          context,
          TypeDeactivatedAudit.entry(typeId, {
            after: { publishedRevisionId: type.publishedRevisionId },
          }),
        );
        await deps.outbox.append(context, [
          CertificationTypeDeactivated.record({
            aggregateId: typeId,
            aggregateVersion: version.value + 1,
            occurredAt: now,
            payload: { typeId },
          }),
        ]);
        return ok({ typeId, status: 'inactive' as const, version: version.value + 1 });
      })
      .catch((error: unknown) => registryFailure(context, 'certification.type-deactivate', error));
  }
}
