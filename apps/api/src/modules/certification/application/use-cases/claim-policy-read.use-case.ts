import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_CLAIM_POLICY_VIEW } from '../../contracts/permissions';
import { policyRevisionDiff, type PolicyRow } from '../../domain/claim-policy';
import type { TypeDefaultBasis } from '../../domain/type-revision';
import type {
  PolicyRevisionSummary,
  StoredPolicy,
  StoredPolicyRevision,
} from '../ports/claim-policy.repository';
import type { ChangeReasonRead } from '../ports/registry-cipher';
import type { StoredProposal } from '../ports/registry.repository';
import {
  policyProposalView,
  rowView,
  type ClaimPolicyDependencies,
  type PolicyRowView,
} from '../registry/claim-policy.shared';
import {
  adminOf,
  invalid,
  parseTypeId,
  registryFailure,
  type RelaxationProposalView,
  type ValidationFailure,
} from '../registry/registry.shared';

/** The history the page shows: the latest revisions, newest first. */
const HISTORY_LIMIT = 50;

export interface ClaimPolicyReadInput {
  readonly typeId: unknown;
}

export interface ClaimPolicyReadOutput {
  readonly typeId: string;
  readonly typeCode: string;
  /** What a query gets when no row of the published revision matches (design 4.2 step 3). */
  readonly defaultBasis: TypeDefaultBasis;
  /** Null until the first save of the type's policy. */
  readonly policyId: string | null;
  /** The version a save sends back; 0 when the type has no policy yet. */
  readonly version: number;
  readonly published: {
    readonly revisionId: string;
    readonly revisionNo: number;
    readonly rows: readonly PolicyRowView[];
    readonly authorAccountId: string;
    readonly createdAt: string;
    readonly reason: ChangeReasonRead | null;
  } | null;
  /** A relaxing revision waiting for a second admin, with its rows (design 3.7, 7.6). */
  readonly pendingRevision: {
    readonly proposal: RelaxationProposalView;
    readonly rows: readonly PolicyRowView[];
  } | null;
  readonly history: readonly {
    readonly revisionId: string;
    readonly revisionNo: number;
    readonly authorAccountId: string;
    readonly createdAt: string;
    readonly reasonGiven: boolean;
    readonly published: boolean;
  }[];
}

export type ClaimPolicyReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'type.not-found' }
  | ValidationFailure;

interface Snapshot {
  readonly typeCode: string;
  readonly defaultBasis: TypeDefaultBasis;
  readonly policy: StoredPolicy | null;
  readonly published: StoredPolicyRevision | null;
  readonly proposal: StoredProposal | null;
  readonly proposed: StoredPolicyRevision | null;
  readonly history: readonly PolicyRevisionSummary[];
}

/**
 * `claim-policy.read` (certification design 3.7, 7.2, 7.6; CERT-42; slice 13): the policy of one
 * type: its published rows with the change reason, a pending relaxation with the row diff a
 * second admin approves and the actions the reader may take, and the revision history (no reason
 * text in the list). The type's default basis is shown because it decides every query no row
 * matches. Reasons are opened outside the unit; a destroyed reason key shows `erased`. Rule: key
 * `certification.claim-policy.view`, the admin population.
 */
export class ClaimPolicyRead extends UseCase<
  ClaimPolicyReadInput,
  ClaimPolicyReadOutput,
  ClaimPolicyReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.claim-policy-read',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_CLAIM_POLICY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ClaimPolicyDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ClaimPolicyReadInput,
  ): Promise<Result<ClaimPolicyReadOutput, ClaimPolicyReadFailure>> {
    const admin = adminOf(context, { write: false });
    if (admin === null) return err({ code: 'access.denied' });
    const typeId = parseTypeId(input?.typeId);
    if (typeId === null) return invalid('typeId', 'format');
    const { market } = context;
    const { deps } = this;
    const read = await deps.unitOfWork
      .run<Snapshot | null, never>(
        market,
        async () => {
          const type = await deps.registry.type(market, typeId);
          if (type === null) return ok(null);
          const typeRevision = await deps.registry.revision(market, type.publishedRevisionId);
          if (typeRevision === null) throw new Error('certification type without its revision');
          const policy = await deps.policies.policyOfType(market, typeId);
          let published: StoredPolicyRevision | null = null;
          let proposal: StoredProposal | null = null;
          let proposed: StoredPolicyRevision | null = null;
          let history: readonly PolicyRevisionSummary[] = [];
          if (policy !== null) {
            if (policy.publishedRevisionId !== null) {
              published = await deps.policies.revision(market, policy.publishedRevisionId);
              if (published === null) throw new Error('claim policy without its revision');
            }
            proposal = await deps.registry.pendingProposal(
              market,
              'claim-policy-revision',
              policy.id,
            );
            if (proposal?.proposedRevisionId != null) {
              proposed = await deps.policies.revision(
                market,
                proposal.proposedRevisionId as StoredPolicyRevision['id'],
              );
            }
            history = await deps.policies.revisions(market, policy.id, HISTORY_LIMIT);
          }
          return ok({
            typeCode: type.code,
            defaultBasis: typeRevision.content.defaultBasis,
            policy,
            published,
            proposal,
            proposed,
            history,
          });
        },
        { readOnly: true },
      )
      .catch((error: unknown) =>
        registryFailure(context, 'certification.claim-policy-read', error),
      );
    if (!read.ok) return read;
    if (read.value === null) return err({ code: 'type.not-found' });
    const { typeCode, defaultBasis, policy, published, proposal, proposed, history } = read.value;
    try {
      const reason =
        published?.changeReasonCiphertext == null
          ? null
          : await deps.cipher.openChangeReason(
              market,
              published.id,
              published.changeReasonCiphertext,
            );
      const publishedRows: readonly PolicyRow[] = published?.rows ?? [];
      return ok({
        typeId,
        typeCode,
        defaultBasis,
        policyId: policy?.id ?? null,
        version: policy?.version ?? 0,
        published:
          published === null
            ? null
            : {
                revisionId: published.id,
                revisionNo: published.revisionNo,
                rows: published.rows.map(rowView),
                authorAccountId: published.authorAccountId,
                createdAt: published.createdAt.toString(),
                reason,
              },
        pendingRevision:
          proposal === null
            ? null
            : {
                proposal: await policyProposalView(
                  deps,
                  market,
                  proposal,
                  admin.accountId,
                  proposed,
                  proposed === null
                    ? []
                    : policyRevisionDiff(publishedRows, proposed.rows, defaultBasis),
                ),
                rows: (proposed?.rows ?? []).map(rowView),
              },
        history: history.map((entry) => ({
          revisionId: entry.id,
          revisionNo: entry.revisionNo,
          authorAccountId: entry.authorAccountId,
          createdAt: entry.createdAt.toString(),
          reasonGiven: entry.reasonGiven,
          published: entry.id === policy?.publishedRevisionId,
        })),
      });
    } catch (error) {
      return registryFailure(context, 'certification.claim-policy-read.reason', error);
    }
  }
}
