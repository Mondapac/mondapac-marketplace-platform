import { Logger } from '@nestjs/common';
import type { CallContext } from '@mondapac/shared-kernel';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { RevertOutcome, RevertRequest, SystemChangeReverter } from '../../../system-requests';
import { ClaimPolicyRevertedAudit, TypeRevisionRevertedAudit } from '../../domain/audit';
import { policyRevisionDiff, relaxesPolicy, type PolicyRow } from '../../domain/claim-policy';
import { CertificationTypeRevised, ClaimPolicyChanged } from '../../domain/events';
import {
  classifyTypeRevision,
  publicationOf,
  validateTypeRevision,
} from '../../domain/type-revision';
import { revisionIdIn, reverterOf } from './certification-review';
import type { ClaimPolicyDependencies } from './claim-policy.shared';
import { parseTypeId, type RegistryDependencies } from './registry.shared';

// The reverters of area certification (see certification-review.ts). Each restores the revision
// before a rejected or withdrawn save, in the open unit of that decision, only while the subject
// still holds the revision after it. A revert is a new revision with the content before (a save is
// never an edit), published as an admin's save is: the same event, so catalog re-checks the tags
// a claim-policy change touches (the type's event is the save's too).
//
// Safety (CERT-21, ADR-0012; Hassan): a revert never loosens enforcement. It is classified by the
// rule an admin's save meets; a revert that save would send to a second admin (it relaxes a
// setting, removes a claim term or a locale, makes a basis less strict, removes a row that is
// not SELLER_OR_MANUFACTURER) answers `not-permitted` and the request stays open. So does a revert
// while a relaxation of the subject waits for a second admin (a save is refused then too).

const logger = new Logger('CertificationReverter');

const logReverted = (
  context: CallContext,
  kind: string,
  subjectId: string,
  revisionId: string,
  requestId: string,
): void => {
  logger.log({
    msg: 'certification.revision.reverted',
    kind,
    subjectId,
    revisionId,
    requestId,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
};

const logRefused = (context: CallContext, kind: string, outcome: RevertOutcome, why: string) => {
  logger.log({
    msg: 'certification.revision.revert-refused',
    kind,
    outcome,
    why,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
};

/**
 * `certification.type-revision`: restores the type's content before a published save. The type's
 * row is locked first under the version just read; the current published revision must be the one
 * the save published (`changed-since` otherwise). The content before must still be a valid
 * revision for the Market (its locales may have changed since: `gone` then).
 */
export async function revertTypeRevision(
  deps: RegistryDependencies,
  context: CallContext,
  request: RevertRequest,
): Promise<RevertOutcome> {
  const admin = reverterOf(context);
  const kind = 'certification.type-revision';
  const { market } = context;
  const typeId = parseTypeId(request.subjectRef);
  const restoreId = revisionIdIn<'CertificationTypeRevision'>(request.before);
  const expectedId = revisionIdIn<'CertificationTypeRevision'>(request.after);
  if (typeId === null || !restoreId || !expectedId) return 'gone';

  const seen = await deps.registry.type(market, typeId);
  if (seen === null) return 'gone';
  try {
    await deps.registry.lockType(market, typeId, seen.version);
  } catch (error) {
    if (error instanceof StaleAggregateError) return 'changed-since';
    throw error;
  }
  const type = await deps.registry.type(market, typeId);
  if (type === null) return 'gone';
  if (type.publishedRevisionId !== expectedId) return 'changed-since';
  if ((await deps.registry.pendingProposal(market, 'type-revision', typeId)) !== null) {
    logRefused(context, kind, 'not-permitted', 'proposal-pending');
    return 'not-permitted';
  }
  const current = await deps.registry.revision(market, type.publishedRevisionId);
  if (current === null) throw new Error('certification type without its revision');
  const restored = await deps.registry.revision(market, restoreId);
  if (restored === null || restored.typeId !== typeId) return 'gone';
  const checked = validateTypeRevision(
    restored.content,
    deps.supportedLocales(market),
    current.content,
  );
  if (!checked.ok) {
    logRefused(context, kind, 'gone', 'content-invalid');
    return 'gone';
  }
  const classification = classifyTypeRevision(current.content, checked.value);
  if (publicationOf(classification) !== 'publish-now') {
    logRefused(context, kind, 'not-permitted', 'relaxes');
    return 'not-permitted';
  }

  const now = deps.clock.now();
  const revisionId = deps.ids.next<'CertificationTypeRevision'>();
  await deps.registry.addRevision(market, {
    id: revisionId,
    typeId,
    content: checked.value,
    authorAccountId: admin,
    changeReasonCiphertext: null,
    createdAt: now,
  });
  await deps.registry.publishRevision(market, typeId, revisionId, type.version);
  await deps.audit.record(
    context,
    TypeRevisionRevertedAudit.entry(typeId, {
      before: { revisionId: expectedId },
      after: {
        revisionId,
        restoredRevisionId: restoreId,
        claimTermsChanged: classification.claimTermsChanged,
        requestId: request.requestId,
      },
    }),
  );
  await deps.outbox.append(context, [
    CertificationTypeRevised.record({
      aggregateId: typeId,
      aggregateVersion: type.version + 1,
      occurredAt: now,
      payload: { typeId, revisionId, claimTermsChanged: classification.claimTermsChanged },
    }),
  ]);
  logReverted(context, kind, typeId, revisionId, request.requestId);
  return 'reverted';
}

/**
 * `certification.claim-policy`: restores the policy rows before a published save (none, when the
 * save was the type's first). The policy row is locked first under the version just read; the
 * classification uses the type's default as it is now. The rows before name categories that were
 * active when they were published; a restored row only tightens, so a category retired since
 * gains no claim from it.
 */
export async function revertClaimPolicy(
  deps: ClaimPolicyDependencies,
  context: CallContext,
  request: RevertRequest,
): Promise<RevertOutcome> {
  const admin = reverterOf(context);
  const kind = 'certification.claim-policy';
  const { market } = context;
  const typeId = parseTypeId(request.subjectRef);
  const restoreId = revisionIdIn<'ClaimPolicyRevision'>(request.before);
  const expectedId = revisionIdIn<'ClaimPolicyRevision'>(request.after);
  if (typeId === null || restoreId === undefined || !expectedId) return 'gone';

  const seen = await deps.policies.policyOfType(market, typeId);
  if (seen === null) return 'gone';
  try {
    await deps.policies.lockPolicy(market, seen.id, seen.version);
  } catch (error) {
    if (error instanceof StaleAggregateError) return 'changed-since';
    throw error;
  }
  const policy = await deps.policies.policyOfType(market, typeId);
  if (policy === null || policy.id !== seen.id) return 'gone';
  if (policy.publishedRevisionId !== expectedId) return 'changed-since';
  if ((await deps.registry.pendingProposal(market, 'claim-policy-revision', policy.id)) !== null) {
    logRefused(context, kind, 'not-permitted', 'proposal-pending');
    return 'not-permitted';
  }
  const type = await deps.registry.type(market, typeId);
  if (type === null) return 'gone';
  const typeRevision = await deps.registry.revision(market, type.publishedRevisionId);
  if (typeRevision === null) throw new Error('certification type without its revision');
  const current = await deps.policies.revision(market, expectedId);
  if (current === null) throw new Error('claim policy without its revision');
  let rows: readonly PolicyRow[] = [];
  if (restoreId !== null) {
    const restored = await deps.policies.revision(market, restoreId);
    if (restored === null || restored.policyId !== policy.id) return 'gone';
    rows = restored.rows;
  }
  const changes = policyRevisionDiff(current.rows, rows, typeRevision.content.defaultBasis);
  if (relaxesPolicy(changes)) {
    logRefused(context, kind, 'not-permitted', 'relaxes');
    return 'not-permitted';
  }

  const now = deps.clock.now();
  const revisionId = deps.ids.next<'ClaimPolicyRevision'>();
  await deps.policies.addRevision(market, {
    id: revisionId,
    policyId: policy.id,
    rows,
    authorAccountId: admin,
    changeReasonCiphertext: null,
    createdAt: now,
  });
  await deps.policies.publishRevision(market, policy.id, revisionId, policy.version);
  await deps.audit.record(
    context,
    ClaimPolicyRevertedAudit.entry(policy.id, {
      before: { revisionId: expectedId },
      after: {
        typeId,
        revisionId,
        restoredRevisionId: restoreId,
        requestId: request.requestId,
      },
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
  logReverted(context, kind, policy.id, revisionId, request.requestId);
  return 'reverted';
}

/** The reverter certification registers for `certification.type-revision`. */
export class TypeRevisionReverter implements SystemChangeReverter {
  constructor(private readonly deps: RegistryDependencies) {}

  revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    return revertTypeRevision(this.deps, context, request);
  }
}

/** The reverter certification registers for `certification.claim-policy`. */
export class ClaimPolicyReverter implements SystemChangeReverter {
  constructor(private readonly deps: ClaimPolicyDependencies) {}

  revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    return revertClaimPolicy(this.deps, context, request);
  }
}
