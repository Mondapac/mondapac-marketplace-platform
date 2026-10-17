import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_ISSUER_EDIT } from '../../contracts/permissions';
import { IssuerReactivationApprovedAudit } from '../../domain/audit';
import { approveReactivation, type IssuerProblem } from '../../domain/issuer';
import { closeProposal, type ProposalProblem } from '../../domain/registry';
import type { StoredProposal } from '../ports/registry.repository';
import {
  adminOf,
  invalid,
  parseProposalId,
  parseRegistryIssuerId,
  registryFailure,
  versionIn,
  type RegistryDependencies,
  type ValidationFailure,
} from '../registry/registry.shared';

export interface IssuerApproveReactivationInput {
  readonly issuerId: unknown;
  readonly proposalId: unknown;
  /** The proposal's version the second admin read. */
  readonly version: unknown;
}

export interface IssuerApproveReactivationOutput {
  readonly issuerId: string;
  readonly proposalId: string;
  readonly state: 'active';
  readonly issuerVersion: number;
}

export type IssuerApproveReactivationFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'proposal.not-found' }
  | { readonly code: 'conflict.stale' }
  | ProposalProblem
  | IssuerProblem
  | ValidationFailure;

const SAME_ADMIN = { code: 'review.second-admin-required' } as const;

/**
 * `issuer.approve-reactivation` (certification design 3.5 last row, 7.2; H1): a second admin with
 * `certification.issuer.edit`, who is not the requester (`review.second-admin-required`; the row's
 * CHECK says the same), makes a `closed-to-new` issuer `active` again under the new expert
 * reference. The reference is opened from the proposal and sealed for the issuer outside the unit
 * (labels bind each ciphertext to its column). One unit, issuer row first and then the proposal
 * (the lock order of derecognise): the issuer's state and reference under the issuer's version,
 * the proposal `approved` under its version, `certification.issuer.reactivation-approved`. Rule: key `certification.issuer.edit`
 * (protected), not acting-as.
 */
export class IssuerApproveReactivation extends UseCase<
  IssuerApproveReactivationInput,
  IssuerApproveReactivationOutput,
  IssuerApproveReactivationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.issuer-approve-reactivation',
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
    input: IssuerApproveReactivationInput,
  ): Promise<Result<IssuerApproveReactivationOutput, IssuerApproveReactivationFailure>> {
    const admin = adminOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const issuerId = parseRegistryIssuerId(input.issuerId);
    if (issuerId === null) return invalid('issuerId', 'format');
    const proposalId = parseProposalId(input.proposalId);
    if (proposalId === null) return invalid('proposalId', 'format');
    const version = versionIn(input.version);
    if (!version.ok) return err(version.error);
    const { deps } = this;
    const { market } = context;

    const ofIssuer = (p: StoredProposal | null): p is StoredProposal =>
      p !== null &&
      p.subject === 'issuer-reactivation' &&
      p.subjectId === issuerId &&
      p.proposedExpertReferenceCiphertext !== null;

    // 1. The proposal; the second-admin rule is answered before any decryption.
    const read = await deps.unitOfWork
      .run<StoredProposal | null, never>(
        market,
        async () => ok(await deps.registry.proposal(market, proposalId)),
        { readOnly: true },
      )
      .catch((error: unknown) =>
        registryFailure(context, 'certification.issuer-approve-reactivation.read', error),
      );
    if (!read.ok) return read;
    const first = read.value;
    if (!ofIssuer(first)) return err({ code: 'proposal.not-found' });
    const allowed = closeProposal(first, 'approve', admin.accountId);
    if (!allowed.ok) return err(allowed.error);
    if (first.version !== version.value) return err({ code: 'conflict.stale' });

    // 2. Outside the unit: the new reference, sealed again for the issuer's column.
    let sealed: string;
    let approval;
    try {
      approval = await deps.cipher.openExpertApproval(
        market,
        'proposal',
        first.proposedExpertReferenceCiphertext!,
      );
      sealed = await deps.cipher.sealExpertApproval(market, 'issuer', approval);
    } catch (error) {
      return registryFailure(context, 'certification.issuer-approve-reactivation.seal', error);
    }

    // 3. One unit: everything checked again on the current rows.
    const now = deps.clock.now();
    return deps.unitOfWork
      .run<IssuerApproveReactivationOutput, IssuerApproveReactivationFailure>(market, async () => {
        const proposal = await deps.registry.proposal(market, proposalId);
        if (!ofIssuer(proposal)) return err({ code: 'proposal.not-found' } as const);
        if (
          proposal.version !== version.value ||
          proposal.proposedExpertReferenceCiphertext !== first.proposedExpertReferenceCiphertext
        ) {
          return err({ code: 'conflict.stale' } as const);
        }
        const issuer = await deps.registry.issuer(market, issuerId);
        if (issuer === null) return err({ code: 'proposal.not-found' } as const);
        const closed = closeProposal(proposal, 'approve', admin.accountId);
        if (!closed.ok) return err(closed.error);
        const next = approveReactivation(
          {
            state: issuer.state,
            expertApproval: null,
            reactivation: { requestedBy: proposal.proposerAccountId, expertApproval: approval },
          },
          admin.accountId,
        );
        if (!next.ok)
          return err(next.error.code === 'approval.same-admin' ? SAME_ADMIN : next.error);
        // Lock order: the issuer, then its proposal (as derecognise does).
        await deps.registry.setIssuerState(market, {
          id: issuerId,
          expectedVersion: issuer.version,
          state: 'active',
          expertReferenceCiphertext: sealed,
          accountId: admin.accountId,
          changedAt: now,
        });
        await deps.registry.closeProposal(market, {
          id: proposalId,
          expectedVersion: version.value,
          state: 'approved',
          decidedByAccountId: admin.accountId,
          decidedAt: now,
        });
        await deps.audit.record(
          context,
          IssuerReactivationApprovedAudit.entry(issuerId, { after: { proposalId } }),
        );
        return ok({
          issuerId,
          proposalId,
          state: 'active' as const,
          issuerVersion: issuer.version + 1,
        });
      })
      .catch((error: unknown) =>
        registryFailure(context, 'certification.issuer-approve-reactivation.write', error),
      );
  }
}
