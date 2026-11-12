import type { CallContext, Id, Result } from '@mondapac/shared-kernel';

/** The membership answer could not be read: the caller refuses its change (fail closed). */
export interface CultureMembersUnavailable {
  readonly code: 'culture-members.unavailable';
}

/**
 * Whether any seller is approved in a culture (ADR-0048, security review M1). A culture's required
 * certification type decides whether an approval needed a certificate, so `CultureEdit` refuses to
 * set or change it while someone is approved. Bound to the sellers facade's
 * `cultureHasApprovedMembers`; a refusal, a fault or an answer of the wrong shape is unavailable,
 * never "nobody".
 */
export interface CultureMembers {
  hasApproved(
    context: CallContext,
    cultureId: Id<'Culture'>,
  ): Promise<Result<boolean, CultureMembersUnavailable>>;
}

export const CULTURE_MEMBERS = Symbol('CATALOG_CULTURE_MEMBERS');
