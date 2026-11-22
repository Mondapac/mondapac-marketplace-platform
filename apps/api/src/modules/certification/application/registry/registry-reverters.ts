import { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { RevertOutcome, RevertRequest, SystemChangeReverter } from '../../../system-requests';
import {
  CERTIFICATION_CLAIM_POLICY_EDIT,
  CERTIFICATION_TYPE_EDIT,
} from '../../contracts/permissions';
import { ClaimPolicyRevertedAudit, TypeRevisionRevertedAudit } from '../../domain/audit';
import {
  policyRevisionDiff,
  relaxesPolicy,
  selectorKey,
  type PolicyRow,
} from '../../domain/claim-policy';
import { MAX_CATALOG_REFERENCE_IDS } from '../ports/catalog-references';
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
// never an edit), published as an admin's save is, with the save's own event. Only the
// claim-policy event makes catalog re-check tags; nothing consumes the type's event yet.
//
// Safety (CERT-21, ADR-0012; Hassan): a revert never loosens enforcement. It is classified by the
// rule an admin's save meets; a revert that save would send to a second admin (it relaxes a
// setting, removes a claim term or a locale, makes a basis less strict, removes a row that is
// not SELLER_OR_MANUFACTURER) answers `not-permitted` and the request stays open. So does a revert
// while a relaxation of the subject waits for a second admin (a save is refused then too).
//
// Before the decision unit opens, `check` runs what the admin's own save checks but cannot run
// inside that unit (each opens a unit of its own): the decider must hold the subject's edit key
// (`certification.type.edit`, `certification.claim-policy.edit`), and every platform category a
// restored policy row adds or changes must still be an active category of the Market (catalog's
// `CatalogReferences`). Any doubt (an error, an unreadable store) is `not-permitted`.

const logger = new Logger('CertificationReverter');

type CheckAnswer = 'ok' | 'not-permitted';

/** A signed-in admin acting as themselves, without throwing (the check fails closed). */
const isOwnAdmin = (context: CallContext): boolean => {
  const actor = context.actor;
  const acting =
    Object.hasOwn(actor, 'actingAs') && (actor as { readonly actingAs?: unknown }).actingAs != null;
  return actor.kind === 'authenticated' && actor.population === 'admin' && !acting;
};

/** Whether the decider holds `key`, as the save's gate asks it; an error answers no. */
async function holdsEditKey(
  authorisation: AuthorisationCheck,
  context: CallContext,
  name: string,
  key: (typeof CERTIFICATION_TYPE_EDIT)['key'],
): Promise<boolean> {
  if (!isOwnAdmin(context)) return false;
  try {
    const decision = await authorisation.check(context, {
      name,
      rule: { kind: 'permissions', allOf: [key] },
    });
    return decision.allowed;
  } catch {
    return false;
  }
}

/** The pre-unit check of a type revert: the decider holds `certification.type.edit`. */
export async function checkTypeRevisionRevert(
  authorisation: AuthorisationCheck,
  context: CallContext,
): Promise<CheckAnswer> {
  const kind = 'certification.type-revision';
  if (
    !(await holdsEditKey(
      authorisation,
      context,
      'certification.type-revision-revert',
      CERTIFICATION_TYPE_EDIT.key,
    ))
  ) {
    logRefused(context, kind, 'not-permitted', 'edit-key');
    return 'not-permitted';
  }
  return 'ok';
}

/**
 * The pre-unit check of a claim-policy revert: the decider holds `certification.claim-policy.edit`,
 * and every platform category of a row the revert would add or change is still an active category
 * of the Market. A subject that is gone or moved on is left to `revert`, which writes nothing then.
 */
export async function checkClaimPolicyRevert(
  deps: ClaimPolicyDependencies,
  authorisation: AuthorisationCheck,
  context: CallContext,
  request: RevertRequest,
): Promise<CheckAnswer> {
  const kind = 'certification.claim-policy';
  if (
    !(await holdsEditKey(
      authorisation,
      context,
      'certification.claim-policy-revert',
      CERTIFICATION_CLAIM_POLICY_EDIT.key,
    ))
  ) {
    logRefused(context, kind, 'not-permitted', 'edit-key');
    return 'not-permitted';
  }
  const { market } = context;
  const typeId = parseTypeId(request.subjectRef);
  const restoreId = revisionIdIn<'ClaimPolicyRevision'>(request.before);
  const expectedId = revisionIdIn<'ClaimPolicyRevision'>(request.after);
  if (typeId === null || restoreId === undefined || !expectedId) return 'ok';
  try {
    const read = await deps.unitOfWork.run<readonly Id<'Category'>[] | null, never>(
      market,
      async () => {
        const policy = await deps.policies.policyOfType(market, typeId);
        const type = await deps.registry.type(market, typeId);
        if (policy === null || type === null || policy.publishedRevisionId !== expectedId) {
          return ok(null);
        }
        const typeRevision = await deps.registry.revision(market, type.publishedRevisionId);
        const current = await deps.policies.revision(market, expectedId);
        const restored =
          restoreId === null ? null : await deps.policies.revision(market, restoreId);
        if (typeRevision === null || current === null) return ok(null);
        if (restoreId !== null && (restored === null || restored.policyId !== policy.id)) {
          return ok(null);
        }
        const rows = restored?.rows ?? [];
        const changes = policyRevisionDiff(current.rows, rows, typeRevision.content.defaultBasis);
        const touched = new Set(changes.map((change) => change.path));
        return ok(
          rows.flatMap((row) =>
            row.selector.kind === 'platform-category' &&
            touched.has(`row:${selectorKey(row.selector)}`)
              ? [row.selector.categoryId]
              : [],
          ),
        );
      },
      { readOnly: true },
    );
    if (!read.ok || read.value === null || read.value.length === 0) return 'ok';
    const categoryIds = read.value;
    if (categoryIds.length > MAX_CATALOG_REFERENCE_IDS) {
      logRefused(context, kind, 'not-permitted', 'too-many-categories');
      return 'not-permitted';
    }
    const active = await deps.catalog.platformCategoriesExist(market, categoryIds);
    if (categoryIds.some((id) => !active.has(id))) {
      logRefused(context, kind, 'not-permitted', 'category-unknown');
      return 'not-permitted';
    }
    return 'ok';
  } catch {
    logRefused(context, kind, 'not-permitted', 'check-failed');
    return 'not-permitted';
  }
}

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
  // A pending relaxation or reactivation was proposed on the published revision; a revert would
  // change what its second admin approves.
  if (
    (await deps.registry.pendingProposal(market, 'type-revision', typeId)) !== null ||
    (await deps.registry.pendingProposal(market, 'type-reactivation', typeId)) !== null
  ) {
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
  constructor(
    private readonly deps: RegistryDependencies,
    private readonly authorisation: AuthorisationCheck,
  ) {}

  check(context: CallContext): Promise<CheckAnswer> {
    return checkTypeRevisionRevert(this.authorisation, context);
  }

  revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    return revertTypeRevision(this.deps, context, request);
  }
}

/** The reverter certification registers for `certification.claim-policy`. */
export class ClaimPolicyReverter implements SystemChangeReverter {
  constructor(
    private readonly deps: ClaimPolicyDependencies,
    private readonly authorisation: AuthorisationCheck,
  ) {}

  check(context: CallContext, request: RevertRequest): Promise<CheckAnswer> {
    return checkClaimPolicyRevert(this.deps, this.authorisation, context, request);
  }

  revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    return revertClaimPolicy(this.deps, context, request);
  }
}
