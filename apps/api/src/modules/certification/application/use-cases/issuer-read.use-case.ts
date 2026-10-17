import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_ISSUER_VIEW } from '../../contracts/permissions';
import type { StoredIssuer, StoredProposal } from '../ports/registry.repository';
import {
  adminOf,
  invalid,
  parseRegistryIssuerId,
  proposalView,
  registryFailure,
  type RegistryDependencies,
  type RelaxationProposalView,
  type ValidationFailure,
} from '../registry/registry.shared';
import type { IssuerSummary } from './issuers-list.use-case';

export interface IssuerReadInput {
  readonly issuerId: unknown;
}

export interface IssuerReadOutput extends IssuerSummary {
  readonly stateChangedByKind: 'admin' | 'seed';
  readonly stateChangedByAccountId: string | null;
  /** Whether an expert approval reference is stored (it is read on its own audited route). */
  readonly expertReferenceRecorded: boolean;
  /**
   * The approved seller certificates whose approved submission names this issuer, now: the number
   * the derecognition form asks the admin to confirm (brief s12).
   */
  readonly affectedCertificates: number;
  /** A reactivation waiting for a second admin (H1), without its reference. */
  readonly pendingReactivation: RelaxationProposalView | null;
  readonly createdAt: string;
}

export type IssuerReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'issuer.not-found' }
  | ValidationFailure;

/**
 * `issuers.read` (certification design 3.5, 7.2; slice 12): one issuer with its state, the number
 * of approved certificates a derecognition would end, and a pending reactivation with the reader's
 * actions. Never the expert reference (`issuer.expert-reference-read`, under the edit key, is
 * audited). Rule: key `certification.issuer.view`, the admin population.
 */
export class IssuerRead extends UseCase<IssuerReadInput, IssuerReadOutput, IssuerReadFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.issuer-read',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_ISSUER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RegistryDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: IssuerReadInput,
  ): Promise<Result<IssuerReadOutput, IssuerReadFailure>> {
    const admin = adminOf(context, { write: false });
    if (admin === null) return err({ code: 'access.denied' });
    const issuerId = parseRegistryIssuerId(input?.issuerId);
    if (issuerId === null) return invalid('issuerId', 'format');
    const { deps } = this;
    const { market } = context;
    const read = await deps.unitOfWork
      .run<{ issuer: StoredIssuer; count: number; pending: StoredProposal | null } | null, never>(
        market,
        async () => {
          const issuer = await deps.registry.issuer(market, issuerId);
          if (issuer === null) return ok(null);
          const count = await deps.registry.approvedCertificateCount(market, issuerId);
          const pending = await deps.registry.pendingProposal(
            market,
            'issuer-reactivation',
            issuerId,
          );
          return ok({ issuer, count, pending });
        },
        { readOnly: true },
      )
      .catch((error: unknown) => registryFailure(context, 'certification.issuer-read', error));
    if (!read.ok) return read;
    if (read.value === null) return err({ code: 'issuer.not-found' });
    const { issuer, count, pending } = read.value;
    try {
      return ok({
        issuerId: issuer.id,
        typeId: issuer.typeId,
        typeCode: issuer.typeCode,
        displayName: issuer.displayName,
        accreditationNumber: issuer.accreditationNumber,
        state: issuer.state,
        version: issuer.version,
        stateChangedAt: issuer.stateChangedAt.toString(),
        stateChangedByKind: issuer.stateChangedByKind,
        stateChangedByAccountId: issuer.stateChangedByAccountId,
        expertReferenceRecorded: issuer.expertReferenceCiphertext !== null,
        affectedCertificates: count,
        pendingReactivation:
          pending === null
            ? null
            : await proposalView(deps, market, pending, admin.accountId, {
                based: null,
                proposed: null,
              }),
        createdAt: issuer.createdAt.toString(),
      });
    } catch (error) {
      return registryFailure(context, 'certification.issuer-read.reason', error);
    }
  }
}
