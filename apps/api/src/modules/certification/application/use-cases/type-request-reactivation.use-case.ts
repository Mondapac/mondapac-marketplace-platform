import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_TYPE_EDIT } from '../../contracts/permissions';
import { TypeReactivationRequestedAudit } from '../../domain/audit';
import { RelaxationProposed } from '../../domain/events';
import {
  changeReasonIn,
  requestTypeReactivation,
  type TypeStatusProblem,
} from '../../domain/registry';
import {
  adminOf,
  invalid,
  parseTypeId,
  registryFailure,
  versionIn,
  type RegistryDependencies,
  type ValidationFailure,
} from '../registry/registry.shared';

export interface TypeRequestReactivationInput {
  readonly typeId: unknown;
  readonly version: unknown;
  readonly reason?: unknown;
}

export interface TypeRequestReactivationOutput {
  readonly typeId: string;
  readonly proposalId: string;
  readonly status: 'inactive';
}

export type TypeRequestReactivationFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'type.not-found' }
  | { readonly code: 'review.proposal-pending' }
  | { readonly code: 'conflict.stale' }
  | TypeStatusProblem
  | ValidationFailure;

/**
 * `types.request-reactivation` (certification design 3.6; H1): an `inactive` type becomes active
 * only when a second admin approves; this writes the `type-reactivation` proposal `pending` and the
 * type stays inactive until then. One pending proposal per type (`review.proposal-pending`). The
 * optional reason is sealed under the proposal's own key in the unit (CE8). Audit
 * `.type.reactivation-requested`; `relaxation-proposed.v1`. Rule: key `certification.type.edit`.
 */
export class TypeRequestReactivation extends UseCase<
  TypeRequestReactivationInput,
  TypeRequestReactivationOutput,
  TypeRequestReactivationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.type-request-reactivation',
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
    input: TypeRequestReactivationInput,
  ): Promise<Result<TypeRequestReactivationOutput, TypeRequestReactivationFailure>> {
    const admin = adminOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const typeId = parseTypeId(input.typeId);
    if (typeId === null) return invalid('typeId', 'format');
    const version = versionIn(input.version);
    if (!version.ok) return err(version.error);
    const reason = changeReasonIn(input.reason);
    if (!reason.ok) return invalid('reason', reason.code);
    const { deps } = this;
    const { market } = context;
    const now = deps.clock.now();
    const proposalId = deps.ids.next<'RelaxationProposal'>();
    return deps.unitOfWork
      .run<TypeRequestReactivationOutput, TypeRequestReactivationFailure>(market, async () => {
        const type = await deps.registry.type(market, typeId);
        if (type === null) return err({ code: 'type.not-found' } as const);
        const allowed = requestTypeReactivation(type.status);
        if (!allowed.ok) return err(allowed.error);
        if (type.version !== version.value) return err({ code: 'conflict.stale' } as const);
        if ((await deps.registry.pendingProposal(market, 'type-reactivation', typeId)) !== null) {
          return err({ code: 'review.proposal-pending' } as const);
        }
        const reasonCiphertext =
          reason.value === null
            ? null
            : await deps.cipher.sealChangeReason(market, proposalId, reason.value);
        const refused = await deps.registry.addProposal(market, {
          id: proposalId,
          subject: 'type-reactivation',
          subjectId: typeId,
          basedOnRevisionId: type.publishedRevisionId,
          proposedRevisionId: null,
          proposedExpertReferenceCiphertext: null,
          proposerAccountId: admin.accountId,
          changeReasonCiphertext: reasonCiphertext,
          proposedAt: now,
        });
        if (refused !== null) return err({ code: refused } as const);
        await deps.audit.record(
          context,
          TypeReactivationRequestedAudit.entry(typeId, {
            after: { proposalId, reasonGiven: reasonCiphertext !== null },
          }),
        );
        await deps.outbox.append(context, [
          RelaxationProposed.record({
            aggregateId: proposalId,
            aggregateVersion: 1,
            occurredAt: now,
            payload: { proposalId, subject: 'type-reactivation' },
          }),
        ]);
        return ok({ typeId, proposalId, status: 'inactive' as const });
      })
      .catch((error: unknown) =>
        registryFailure(context, 'certification.type-request-reactivation', error),
      );
  }
}
