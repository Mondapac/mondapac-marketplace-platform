import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_ISSUER_EDIT } from '../../contracts/permissions';
import { IssuerExpertReferenceViewedAudit } from '../../domain/audit';
import type { ExpertApproval } from '../../domain/issuer';
import type { StoredIssuer, StoredProposal } from '../ports/registry.repository';
import {
  adminOf,
  invalid,
  parseRegistryIssuerId,
  registryFailure,
  type RegistryDependencies,
  type ValidationFailure,
} from '../registry/registry.shared';

export interface IssuerExpertReferenceReadInput {
  readonly issuerId: unknown;
}

export interface IssuerExpertReferenceReadOutput {
  readonly issuerId: string;
  /** The reference the issuer is active under; null for a `proposed` issuer. */
  readonly current: ExpertApproval | null;
  /** The new reference of a pending reactivation, which the second admin approves. */
  readonly pendingReactivation: {
    readonly proposalId: string;
    readonly expertApproval: ExpertApproval;
  } | null;
}

export type IssuerExpertReferenceReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'issuer.not-found' }
  | ValidationFailure;

/**
 * `issuer.expert-reference-read` (certification design 3.5; data design 3.22, CE7; slice 12): the
 * expert approval references of an issuer, decrypted under the Market's platform key: the one in
 * force and a pending reactivation's new one, so the second admin sees what they approve (H1). It
 * may name a person: each read writes `certification.issuer.expert-reference-viewed`; the answer
 * is `no-store` and never logged. Rule: key `certification.issuer.edit` (protected), not
 * acting-as.
 */
export class IssuerExpertReferenceRead extends UseCase<
  IssuerExpertReferenceReadInput,
  IssuerExpertReferenceReadOutput,
  IssuerExpertReferenceReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.issuer-expert-reference-read',
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
    input: IssuerExpertReferenceReadInput,
  ): Promise<Result<IssuerExpertReferenceReadOutput, IssuerExpertReferenceReadFailure>> {
    if (adminOf(context, { write: true }) === null) return err({ code: 'access.denied' });
    const issuerId = parseRegistryIssuerId(input?.issuerId);
    if (issuerId === null) return invalid('issuerId', 'format');
    const { deps } = this;
    const { market } = context;
    const read = await deps.unitOfWork
      .run<{ issuer: StoredIssuer; pending: StoredProposal | null } | null, never>(
        market,
        async () => {
          const issuer = await deps.registry.issuer(market, issuerId);
          if (issuer === null) return ok(null);
          const pending = await deps.registry.pendingProposal(
            market,
            'issuer-reactivation',
            issuerId,
          );
          return ok({ issuer, pending });
        },
        { readOnly: true },
      )
      .catch((error: unknown) =>
        registryFailure(context, 'certification.issuer-expert-reference-read', error),
      );
    if (!read.ok) return read;
    if (read.value === null) return err({ code: 'issuer.not-found' });
    const { issuer, pending } = read.value;

    let output: IssuerExpertReferenceReadOutput;
    try {
      output = {
        issuerId,
        current:
          issuer.expertReferenceCiphertext === null
            ? null
            : await deps.cipher.openExpertApproval(
                market,
                'issuer',
                issuer.expertReferenceCiphertext,
              ),
        pendingReactivation:
          pending?.proposedExpertReferenceCiphertext == null
            ? null
            : {
                proposalId: pending.id,
                expertApproval: await deps.cipher.openExpertApproval(
                  market,
                  'proposal',
                  pending.proposedExpertReferenceCiphertext,
                ),
              },
      };
    } catch (error) {
      return registryFailure(context, 'certification.issuer-expert-reference-read.open', error);
    }
    // The read is answered only once its audit row is committed.
    const audited = await deps.unitOfWork
      .run<true, never>(market, async () => {
        await deps.audit.record(
          context,
          IssuerExpertReferenceViewedAudit.entry(issuerId, {
            after: { proposalId: pending?.id ?? null },
          }),
        );
        return ok(true as const);
      })
      .catch((error: unknown) =>
        registryFailure(context, 'certification.issuer-expert-reference-read.audit', error),
      );
    if (!audited.ok) return audited;
    return ok(output);
  }
}
