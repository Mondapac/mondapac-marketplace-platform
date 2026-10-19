import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_CLAIM_POLICY_EDIT } from '../../contracts/permissions';
import { ClaimPolicyRelaxationRequestedAudit, ClaimPolicyRevisedAudit } from '../../domain/audit';
import {
  policyRevisionDiff,
  policyRowsIn,
  relaxesPolicy,
  selectorKey,
  type PolicyRow,
  type PolicyRowChange,
  type PolicyRowProblem,
} from '../../domain/claim-policy';
import { ClaimPolicyChanged, RelaxationProposed } from '../../domain/events';
import { changeReasonIn } from '../../domain/registry';
import type { TypeDefaultBasis } from '../../domain/type-revision';
import { MAX_CATALOG_REFERENCE_IDS } from '../ports/catalog-references';
import type { StoredPolicy } from '../ports/claim-policy.repository';
import { policyVersionIn, type ClaimPolicyDependencies } from '../registry/claim-policy.shared';
import {
  adminOf,
  invalid,
  parseTypeId,
  registryFailure,
  type ValidationFailure,
} from '../registry/registry.shared';

export interface ClaimPolicySaveRevisionInput {
  readonly typeId: unknown;
  /** The policy version the admin read; 0 when the type had no policy yet. */
  readonly version: unknown;
  readonly rows: unknown;
  /** Optional, at most 500 characters; stored only encrypted on the revision (design 3.7). */
  readonly reason?: unknown;
}

export type ClaimPolicySaveRevisionOutput =
  | {
      readonly outcome: 'published';
      readonly typeId: string;
      readonly policyId: string;
      readonly revisionId: string;
      readonly revisionNo: number;
      readonly version: number;
      readonly changes: readonly PolicyRowChange[];
    }
  | {
      readonly outcome: 'pending-second-admin';
      readonly typeId: string;
      readonly policyId: string;
      readonly revisionId: string;
      readonly revisionNo: number;
      readonly proposalId: string;
      /** The policy is unchanged until the approval. */
      readonly version: number;
      readonly changes: readonly PolicyRowChange[];
    };

export type ClaimPolicySaveRevisionFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'type.not-found' }
  | { readonly code: 'claim-policy.revision-unchanged' }
  | { readonly code: 'review.proposal-pending' }
  | { readonly code: 'conflict.stale' }
  | {
      readonly code: 'claim-policy.revision-invalid';
      readonly issues: readonly PolicyRowProblem[];
    }
  | ValidationFailure;

interface Snapshot {
  readonly typeRevisionId: string;
  readonly defaultBasis: TypeDefaultBasis;
  readonly policy: StoredPolicy | null;
  readonly publishedRows: readonly PolicyRow[];
}

const logger = new Logger('ClaimPolicyRevision');

/**
 * `claim-policy.save-revision` (certification design 3.7; CERT-42; ADR-0012 d2; H1; slice 13): a
 * save is a new revision of the type's policy, never an edit. The rows pass `policyRowsIn`
 * (closed values, one row per selector, `SELLER_OR_MANUFACTURER` never on handling, M1); every
 * category of an added or changed row must be an active platform category of the Market
 * (`CatalogReferences`). A revision that only tightens is published in the same unit
 * (`claim-policy-changed.v1`, audit `.claim-policy.revised`). One that relaxes (a basis made less
 * strict, a removed row that is not `SELLER_OR_MANUFACTURER`, an added row less strict than the
 * type's default) is saved and a `claim-policy-revision` proposal waits `pending` for a second
 * admin (audit `.claim-policy.relaxation-requested`, `relaxation-proposed.v1`). While one waits,
 * every save is refused (`review.proposal-pending`). The first save of a type creates its policy
 * (version 0 read). The write unit locks the policy row first, then reads again. Rule: key
 * `certification.claim-policy.edit` (protected), the admin population, not acting-as.
 */
export class ClaimPolicySaveRevision extends UseCase<
  ClaimPolicySaveRevisionInput,
  ClaimPolicySaveRevisionOutput,
  ClaimPolicySaveRevisionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.claim-policy-save-revision',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_CLAIM_POLICY_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ClaimPolicyDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ClaimPolicySaveRevisionInput,
  ): Promise<Result<ClaimPolicySaveRevisionOutput, ClaimPolicySaveRevisionFailure>> {
    const admin = adminOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const typeId = parseTypeId(input.typeId);
    if (typeId === null) return invalid('typeId', 'format');
    const version = policyVersionIn(input.version);
    if (!version.ok) return err(version.error);
    const reason = changeReasonIn(input.reason);
    if (!reason.ok) return invalid('reason', reason.code);
    const parsed = policyRowsIn(input.rows);
    if (!parsed.ok) return err({ code: 'claim-policy.revision-invalid', issues: parsed.error });
    const rows = parsed.value;

    const { deps } = this;
    const { market } = context;

    // 1. The type's default and the published rows, to classify against.
    const read = await deps.unitOfWork
      .run<Snapshot | null, never>(
        market,
        async () => {
          const type = await deps.registry.type(market, typeId);
          if (type === null) return ok(null);
          const typeRevision = await deps.registry.revision(market, type.publishedRevisionId);
          if (typeRevision === null) throw new Error('certification type without its revision');
          const policy = await deps.policies.policyOfType(market, typeId);
          let publishedRows: readonly PolicyRow[] = [];
          if (policy?.publishedRevisionId != null) {
            const published = await deps.policies.revision(market, policy.publishedRevisionId);
            if (published === null) throw new Error('claim policy without its revision');
            publishedRows = published.rows;
          }
          return ok({
            typeRevisionId: type.publishedRevisionId,
            defaultBasis: typeRevision.content.defaultBasis,
            policy,
            publishedRows,
          });
        },
        { readOnly: true },
      )
      .catch((error: unknown) =>
        registryFailure(context, 'certification.claim-policy-save-revision.read', error),
      );
    if (!read.ok) return read;
    if (read.value === null) return err({ code: 'type.not-found' });
    const snapshot = read.value;
    if ((snapshot.policy?.version ?? 0) !== version.value) return err({ code: 'conflict.stale' });

    const changes = policyRevisionDiff(snapshot.publishedRows, rows, snapshot.defaultBasis);
    if (changes.length === 0) return err({ code: 'claim-policy.revision-unchanged' });

    // 2. Every category a row adds or changes exists in the Market (design 3.7, CatalogReferences).
    const touched = new Set(changes.map((change) => change.path));
    const categoryIds = rows.flatMap((row) =>
      row.selector.kind === 'platform-category' && touched.has(`row:${selectorKey(row.selector)}`)
        ? [row.selector.categoryId]
        : [],
    );
    if (categoryIds.length > MAX_CATALOG_REFERENCE_IDS) {
      return err({
        code: 'claim-policy.revision-invalid',
        issues: [{ path: 'rows', code: 'length' }],
      });
    }
    let existing: ReadonlySet<Id<'Category'>>;
    try {
      existing =
        categoryIds.length === 0
          ? new Set()
          : await deps.catalog.platformCategoriesExist(market, categoryIds);
    } catch (error) {
      return registryFailure(context, 'certification.claim-policy-save-revision.catalog', error);
    }
    // Each unknown category is reported at the position the admin sent it.
    const unknown: PolicyRowProblem[] = [];
    (input.rows as readonly unknown[]).forEach((raw, index) => {
      const value = (raw as { categoryId?: unknown }).categoryId;
      const parsedId = typeof value === 'string' ? parseId<'Category'>(value) : null;
      if (parsedId?.ok && categoryIds.includes(parsedId.value) && !existing.has(parsedId.value)) {
        unknown.push({ path: `rows[${index}].categoryId`, code: 'category-unknown' });
      }
    });
    if (unknown.length > 0) return err({ code: 'claim-policy.revision-invalid', issues: unknown });

    const publishNow = !relaxesPolicy(changes);

    // 3. One unit: lock the policy first (or create it), check again, the revision and its
    // reason, then the pointer or the proposal.
    const now = deps.clock.now();
    const revisionId = deps.ids.next<'ClaimPolicyRevision'>();
    const proposalId = deps.ids.next<'RelaxationProposal'>();
    const newPolicyId = deps.ids.next<'ClaimBasisPolicy'>();
    const result = await deps.unitOfWork
      .run<ClaimPolicySaveRevisionOutput, ClaimPolicySaveRevisionFailure>(market, async () => {
        let policy: StoredPolicy;
        if (snapshot.policy === null) {
          await deps.policies.addPolicy(market, { id: newPolicyId, typeId, createdAt: now });
          policy = { id: newPolicyId, typeId, publishedRevisionId: null, version: 1 };
        } else {
          await deps.policies.lockPolicy(market, snapshot.policy.id, version.value);
          const current = await deps.policies.policyOfType(market, typeId);
          if (
            current === null ||
            current.id !== snapshot.policy.id ||
            current.publishedRevisionId !== snapshot.policy.publishedRevisionId
          ) {
            return err({ code: 'conflict.stale' } as const);
          }
          policy = current;
        }
        // The type's default decided the classification: it must not have moved meanwhile.
        const type = await deps.registry.type(market, typeId);
        if (type === null || type.publishedRevisionId !== snapshot.typeRevisionId) {
          return err({ code: 'conflict.stale' } as const);
        }
        if (
          (await deps.registry.pendingProposal(market, 'claim-policy-revision', policy.id)) !== null
        ) {
          return err({ code: 'review.proposal-pending' } as const);
        }
        const reasonCiphertext =
          reason.value === null
            ? null
            : await deps.cipher.sealChangeReason(market, revisionId, reason.value);
        const revisionNo = await deps.policies.addRevision(market, {
          id: revisionId,
          policyId: policy.id,
          rows,
          authorAccountId: admin.accountId,
          changeReasonCiphertext: reasonCiphertext,
          createdAt: now,
        });

        if (publishNow) {
          await deps.policies.publishRevision(market, policy.id, revisionId, policy.version);
          await deps.audit.record(
            context,
            ClaimPolicyRevisedAudit.entry(policy.id, {
              after: { typeId, revisionId, reasonGiven: reasonCiphertext !== null },
            }),
          );
          await deps.outbox.append(context, [
            ClaimPolicyChanged.record({
              aggregateId: policy.id,
              aggregateVersion: policy.version + 1,
              occurredAt: now,
              payload: { policyId: policy.id, revisionId, typeId },
            }),
          ]);
          return ok({
            outcome: 'published' as const,
            typeId,
            policyId: policy.id,
            revisionId,
            revisionNo,
            version: policy.version + 1,
            changes,
          });
        }

        const refused = await deps.registry.addProposal(market, {
          id: proposalId,
          subject: 'claim-policy-revision',
          subjectId: policy.id,
          basedOnRevisionId: policy.publishedRevisionId,
          proposedRevisionId: revisionId,
          proposedExpertReferenceCiphertext: null,
          // The proposer is the revision's author (data design 3.20, Hassan L-b).
          proposerAccountId: admin.accountId,
          // The reason of a revision lives on the revision (design 3.7).
          changeReasonCiphertext: null,
          proposedAt: now,
        });
        if (refused !== null) return err({ code: refused } as const);
        await deps.audit.record(
          context,
          ClaimPolicyRelaxationRequestedAudit.entry(policy.id, {
            after: { typeId, proposalId, revisionId, reasonGiven: reasonCiphertext !== null },
          }),
        );
        await deps.outbox.append(context, [
          RelaxationProposed.record({
            aggregateId: proposalId,
            aggregateVersion: 1,
            occurredAt: now,
            payload: { proposalId, subject: 'claim-policy-revision' },
          }),
        ]);
        return ok({
          outcome: 'pending-second-admin' as const,
          typeId,
          policyId: policy.id,
          revisionId,
          revisionNo,
          proposalId,
          version: policy.version,
          changes,
        });
      })
      .catch((error: unknown) =>
        registryFailure(context, 'certification.claim-policy-save-revision.write', error),
      );
    if (result.ok) {
      logger.log({
        msg: 'certification.claim-policy-revision.saved',
        outcome: result.value.outcome,
        typeId,
        policyId: result.value.policyId as Id,
        revisionId: result.value.revisionId as Id,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    return result;
  }
}
