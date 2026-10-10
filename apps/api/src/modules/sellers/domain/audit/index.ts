import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import type { AuditActionDefinition } from '@mondapac/shared-kernel';

// The audited actions of sellers (sellers design 9; platform-audit 3.2), registered at boot with
// `registerAuditActions('sellers', SELLERS_AUDIT_ACTIONS)` and written through sellers' own
// AUDIT_WRITER in the unit of the change. Ids, codes and instants only: never a name, phone,
// address, identifier, reason text or register value (VER-13, design 8.3). Every new or changed
// action changes the checked-in catalogue snapshot, for the security review.
//
// Slice 7a-read: the audited decrypting read. Later slices add the review checks, the decisions
// and the admin edits of design 9.

/** The audit target type of a seller (the file's id is the seller's id). */
export const SELLER_TARGET = 'sellers.seller';

/** What a decrypting read was for (design 9, Hassan M4). */
export const BUSINESS_DETAILS_READ_KINDS = ['review'] as const;
export type BusinessDetailsReadKind = (typeof BUSINESS_DETAILS_READ_KINDS)[number];

/**
 * An admin read a seller's business details in clear. One row per read, in the same unit as the
 * read; a refused row means nothing is returned. `revisionId` names the revision the reviewer
 * saw; `previousRevisionId` the approved one shown beside it, when there was one.
 */
export const BusinessDetailsViewed = defineAuditAction({
  action: 'sellers.business-details.viewed',
  targetType: SELLER_TARGET,
  actors: ['authenticated'],
  after: {
    readKind: auditField.enumOf(BUSINESS_DETAILS_READ_KINDS),
    revisionId: auditField.id(),
    previousRevisionId: auditField.optional(auditField.id()),
  },
});

/** Every audited action of sellers, for its module's registration. */
export const SELLERS_AUDIT_ACTIONS: readonly AuditActionDefinition[] = Object.freeze([
  BusinessDetailsViewed,
]);
