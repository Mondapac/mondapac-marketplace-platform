import { parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { ChangeValues, RecordedRequest, Risk } from '../../../system-requests';
import type { RegistryDependencies } from './registry.shared';

// Admin Inbox › System requests, area certification (owner decisions of 15 Nov 2026): an admin's
// edit of the certification configuration goes live at once and is reviewed after. Only edits
// that can be put back are reviewed: a type revision and a claim-policy revision that were
// published at their save. A relaxing save already waits for a second admin (H1) and opens no
// request; creating, deactivating, reactivating, issuer state changes and every decision on a
// seller's certificate or a product certification are not field edits and are not reviewed here.
//
// A revert never loosens enforcement: it is classified by the same rule as an admin's save
// (`classifyTypeRevision`, `policyRevisionDiff`), and one that would need a second admin is
// `not-permitted` (the request stays open). The reverters are in registry-reverters.ts.

/** The review area of certification's configuration edits. */
export const CERTIFICATION_REVIEW_AREA = 'certification';
/** A published type revision; subject = the type id; values `{revisionId, revisionNo}`. */
export const TYPE_REVISION_SUBJECT_KIND = 'certification.type-revision';
/**
 * A published claim-policy revision; subject = the type id (a type has one policy); values
 * `{revisionId, revisionNo}`, both null before the type's first policy revision.
 */
export const CLAIM_POLICY_SUBJECT_KIND = 'certification.claim-policy';

/** At most this many changed paths are kept on a request (the rest are counted). */
export const MAX_CHANGED_PATHS = 100;

/** Whether an edit of certification configuration is reviewed in the Market (then a note). */
export interface CertificationReview {
  readonly reviewed: boolean;
  readonly risk: Risk;
}

/** The review request a save opened (null when none), as an answer carries it. */
export type CertificationRequestRef = Pick<RecordedRequest, 'id' | 'number'> | null;

export const requestRef = (request: RecordedRequest | null): CertificationRequestRef =>
  request === null ? null : { id: request.id, number: request.number };

/**
 * The review policy of area certification, for the edit pages (the area's default on a
 * failure). It opens a read-only unit of its own, so call it outside any unit.
 */
export async function certificationReview(
  deps: Pick<RegistryDependencies, 'review'>,
  context: CallContext,
): Promise<CertificationReview> {
  const policy = await deps.review.areaPolicy(context, CERTIFICATION_REVIEW_AREA);
  return { reviewed: policy.enabled, risk: policy.risk };
}

/**
 * The values of a revision pointer kept on a request. The values after also name what changed
 * (diff paths, at most {@link MAX_CHANGED_PATHS}, and their count), for the reviewer; the
 * reverter compares the revision id only.
 */
export function revisionValues(
  revision: { readonly id: string; readonly revisionNo: number } | null,
  changed?: readonly string[],
): ChangeValues {
  const pointer = {
    revisionId: revision?.id ?? null,
    revisionNo: revision?.revisionNo ?? null,
  };
  if (changed === undefined) return pointer;
  const paths = [...new Set(changed)];
  return {
    ...pointer,
    changed: paths.slice(0, MAX_CHANGED_PATHS),
    changedCount: paths.length,
  };
}

/** The revision id kept in a request's values; undefined when the values are not ours. */
export function revisionIdIn<K extends string>(values: ChangeValues): Id<K> | null | undefined {
  const raw = values.revisionId;
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const parsed = parseId<K>(raw);
  return parsed.ok ? parsed.value : undefined;
}

/** A signed-in admin session, not acting as someone else (a revert is the decider's own act). */
export function reverterOf(context: CallContext): Id<'Account'> {
  const actor = context.actor;
  const acting =
    Object.hasOwn(actor, 'actingAs') && (actor as { readonly actingAs?: unknown }).actingAs != null;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin' || acting) {
    throw new Error('certification: a revert needs a signed-in admin acting as themselves');
  }
  return actor.accountId;
}
