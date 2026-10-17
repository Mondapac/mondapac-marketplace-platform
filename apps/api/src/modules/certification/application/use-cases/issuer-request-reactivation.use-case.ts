import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_ISSUER_EDIT } from '../../contracts/permissions';
import { IssuerReactivationRequestedAudit } from '../../domain/audit';
import { RelaxationProposed } from '../../domain/events';
import { requestReactivation, type ExpertApproval, type IssuerProblem } from '../../domain/issuer';
import { changeReasonIn, expertApprovalIn } from '../../domain/registry';
import type { StoredIssuer } from '../ports/registry.repository';
import {
  adminOf,
  invalid,
  parseRegistryIssuerId,
  registryFailure,
  versionIn,
  type RegistryDependencies,
  type ValidationFailure,
} from '../registry/registry.shared';

export interface IssuerRequestReactivationInput {
  readonly issuerId: unknown;
  /** The issuer's version the admin read. */
  readonly version: unknown;
  /** The new expert approval: a reference other than the one in force (H1). */
  readonly expertApproval: unknown;
  readonly reason?: unknown;
}

export interface IssuerRequestReactivationOutput {
  readonly issuerId: string;
  readonly proposalId: string;
  readonly state: 'closed-to-new';
}

export type IssuerRequestReactivationFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'issuer.not-found' }
  | { readonly code: 'review.proposal-pending' }
  | { readonly code: 'conflict.stale' }
  | IssuerProblem
  | ValidationFailure;

/**
 * `issuers.request-reactivation` (certification design 3.5 last row; H1): `closed-to-new` →
 * `active` needs a new expert reference and then the approval of a second admin with
 * `certification.issuer.edit` who is not the requester; until then the issuer stays
 * `closed-to-new`. The reference in force is opened and compared (a re-typed old one is not new,
 * `issuer.expert-approval-not-new`); the new one is sealed under the platform key on the proposal
 * (CE7), outside the unit. One unit: the `issuer-reactivation` proposal `pending` (one per issuer,
 * `review.proposal-pending`), the optional reason under the proposal's own key (CE8),
 * `certification.issuer.reactivation-requested`, `relaxation-proposed.v1`. A derecognised issuer
 * is terminal. Rule: key `certification.issuer.edit` (protected), not acting-as.
 */
export class IssuerRequestReactivation extends UseCase<
  IssuerRequestReactivationInput,
  IssuerRequestReactivationOutput,
  IssuerRequestReactivationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.issuer-request-reactivation',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_ISSUER_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RegistryDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: IssuerRequestReactivationInput,
  ): Promise<Result<IssuerRequestReactivationOutput, IssuerRequestReactivationFailure>> {
    const admin = adminOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const issuerId = parseRegistryIssuerId(input.issuerId);
    if (issuerId === null) return invalid('issuerId', 'format');
    const version = versionIn(input.version);
    if (!version.ok) return err(version.error);
    const approval = expertApprovalIn(input.expertApproval);
    if (!approval.ok) {
      return invalid(
        approval.path === '' ? 'expertApproval' : `expertApproval.${approval.path}`,
        approval.code,
      );
    }
    const reason = changeReasonIn(input.reason);
    if (!reason.ok) return invalid('reason', reason.code);
    const { deps } = this;
    const { market } = context;

    // 1. The issuer, and outside any unit the reference in force (to compare) and the new one
    // sealed for the proposal.
    const read = await deps.unitOfWork
      .run<StoredIssuer | null, never>(
        market,
        async () => ok(await deps.registry.issuer(market, issuerId)),
        { readOnly: true },
      )
      .catch((error: unknown) =>
        registryFailure(context, 'certification.issuer-request-reactivation.read', error),
      );
    if (!read.ok) return read;
    const stored = read.value;
    if (stored === null) return err({ code: 'issuer.not-found' });
    let current: ExpertApproval | null;
    let sealed: string;
    try {
      current =
        stored.expertReferenceCiphertext === null
          ? null
          : await deps.cipher.openExpertApproval(
              market,
              'issuer',
              stored.expertReferenceCiphertext,
            );
      sealed = await deps.cipher.sealExpertApproval(market, 'proposal', approval.value);
    } catch (error) {
      return registryFailure(context, 'certification.issuer-request-reactivation.seal', error);
    }

    // 2. One unit: check again on the current row, then the proposal.
    const now = deps.clock.now();
    const proposalId = deps.ids.next<'RelaxationProposal'>();
    return deps.unitOfWork
      .run<IssuerRequestReactivationOutput, IssuerRequestReactivationFailure>(market, async () => {
        const issuer = await deps.registry.issuer(market, issuerId);
        if (issuer === null) return err({ code: 'issuer.not-found' } as const);
        if (
          issuer.version !== version.value ||
          issuer.expertReferenceCiphertext !== stored.expertReferenceCiphertext
        ) {
          return err({ code: 'conflict.stale' } as const);
        }
        const pending = await deps.registry.pendingProposal(
          market,
          'issuer-reactivation',
          issuerId,
        );
        const asked = requestReactivation(
          {
            state: issuer.state,
            expertApproval: current,
            reactivation:
              pending === null
                ? null
                : { requestedBy: pending.proposerAccountId, expertApproval: approval.value },
          },
          admin.accountId,
          approval.value,
        );
        if (!asked.ok) {
          return err(
            asked.error.code === 'issuer.reactivation-pending'
              ? ({ code: 'review.proposal-pending' } as const)
              : asked.error,
          );
        }
        const reasonCiphertext =
          reason.value === null
            ? null
            : await deps.cipher.sealChangeReason(market, proposalId, reason.value);
        const refused = await deps.registry.addProposal(market, {
          id: proposalId,
          subject: 'issuer-reactivation',
          subjectId: issuerId,
          basedOnRevisionId: null,
          proposedRevisionId: null,
          proposedExpertReferenceCiphertext: sealed,
          proposerAccountId: admin.accountId,
          changeReasonCiphertext: reasonCiphertext,
          proposedAt: now,
        });
        if (refused !== null) return err({ code: refused } as const);
        await deps.audit.record(
          context,
          IssuerReactivationRequestedAudit.entry(issuerId, {
            after: { proposalId, reasonGiven: reasonCiphertext !== null },
          }),
        );
        await deps.outbox.append(context, [
          RelaxationProposed.record({
            aggregateId: proposalId,
            aggregateVersion: 1,
            occurredAt: now,
            payload: { proposalId, subject: 'issuer-reactivation' },
          }),
        ]);
        return ok({ issuerId, proposalId, state: 'closed-to-new' as const });
      })
      .catch((error: unknown) =>
        registryFailure(context, 'certification.issuer-request-reactivation.write', error),
      );
  }
}
