import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import type { PolicyRow, PolicyRowChange } from '../../domain/claim-policy';
import type { ClaimBasisRequirement } from '../../domain/claim-types';
import type { CatalogReferences } from '../ports/catalog-references';
import type { ClaimPolicyRepository, StoredPolicyRevision } from '../ports/claim-policy.repository';
import type { ChangeReasonRead } from '../ports/registry-cipher';
import type { StoredProposal } from '../ports/registry.repository';
import {
  closeSubjectProposal,
  type CloseProposalFailure,
  type CloseProposalInput,
  type CloseProposalOutput,
} from './close-proposal';
import {
  adminOf,
  invalid,
  parseTypeId,
  proposalView,
  registryFailure,
  type RegistryDependencies,
  type RelaxationProposalView,
  type ValidationFailure,
} from './registry.shared';

/** The ports of the claim-policy use cases (slice 13): the registry's, the policy store, catalog. */
export interface ClaimPolicyDependencies extends RegistryDependencies {
  readonly policies: ClaimPolicyRepository;
  readonly catalog: CatalogReferences;
}

/**
 * The policy version the admin read: 0 when the type has no policy yet (the save creates it),
 * otherwise a positive whole number in the column's range.
 */
export function policyVersionIn(
  value: unknown,
): { ok: true; value: number } | { ok: false; error: ValidationFailure } {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2_147_483_646) {
    return { ok: false, error: invalid('version', 'format').error };
  }
  return { ok: true, value };
}

/** One row as the admin page shows and sends it. */
export type PolicyRowView =
  | {
      readonly selector: 'platform-category';
      readonly categoryId: string;
      readonly basis: ClaimBasisRequirement;
    }
  | {
      readonly selector: 'handling';
      readonly handling: string;
      readonly basis: ClaimBasisRequirement;
    };

export function rowView(row: PolicyRow): PolicyRowView {
  return row.selector.kind === 'platform-category'
    ? { selector: 'platform-category', categoryId: row.selector.categoryId, basis: row.basis }
    : { selector: 'handling', handling: row.selector.handling, basis: row.basis };
}

/**
 * The read shape of a pending policy relaxation (design 7.6): the common proposal view, with the
 * reason read from the proposed revision (where a policy revision keeps it, design 3.7) and the
 * row diff against the published revision a second admin approves.
 */
export async function policyProposalView(
  deps: Pick<RegistryDependencies, 'cipher'>,
  market: MarketContext,
  proposal: StoredProposal,
  actorAccountId: string,
  proposed: StoredPolicyRevision | null,
  diff: readonly PolicyRowChange[],
): Promise<RelaxationProposalView> {
  const common = await proposalView(deps, market, proposal, actorAccountId, {
    based: null,
    proposed: null,
  });
  let reason: ChangeReasonRead | null = null;
  if (proposed !== null && proposed.changeReasonCiphertext !== null) {
    reason = await deps.cipher.openChangeReason(
      market,
      proposed.id,
      proposed.changeReasonCiphertext,
    );
  }
  return { ...common, reason, diff };
}

/**
 * Reject or withdraw a pending policy relaxation (design 7.6), addressed by the type: the type's
 * policy is found first, then the common closing unit runs with the policy as the subject.
 * A type without a policy has no proposal (`proposal.not-found`).
 */
export async function closePolicyProposal(
  deps: ClaimPolicyDependencies,
  context: CallContext,
  input: CloseProposalInput,
  action: 'reject' | 'withdraw',
  msg: string,
): Promise<Result<CloseProposalOutput, CloseProposalFailure>> {
  if (adminOf(context, { write: true }) === null) return err({ code: 'access.denied' });
  if (typeof input !== 'object' || input === null) return invalid('body', 'type');
  const typeId = parseTypeId(input.subjectId);
  if (typeId === null) return invalid('typeId', 'format');
  const { market } = context;
  const read = await deps.unitOfWork
    .run(market, async () => ok(await deps.policies.policyOfType(market, typeId)), {
      readOnly: true,
    })
    .catch((error: unknown) => registryFailure(context, `${msg}.read`, error));
  if (!read.ok) return read;
  if (read.value === null) return err({ code: 'proposal.not-found' });
  const policyId: string = read.value.id;
  return closeSubjectProposal(
    deps,
    context,
    { ...input, subjectId: policyId },
    {
      action,
      subjects: ['claim-policy-revision'],
      parseSubjectId: (raw) => (raw === policyId ? policyId : null),
      msg,
    },
  );
}
