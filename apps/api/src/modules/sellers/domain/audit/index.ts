import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import type { AuditActionDefinition } from '@mondapac/shared-kernel';
import { OBSERVED_REGISTER_OUTCOMES } from '../review-check';

// The audited actions of sellers (sellers design 9; platform-audit 3.2), registered at boot with
// `registerAuditActions('sellers', SELLERS_AUDIT_ACTIONS)` and written through sellers' own
// AUDIT_WRITER in the unit of the change. Ids, codes and instants only: never a name, phone,
// address, identifier, reason text or register value (VER-13, design 8.3). Every new or changed
// action changes the checked-in catalogue snapshot, for the security review.
//
// Slice 7a-read: the audited decrypting read. Slice 7a-decide: the manual register check (approve
// and reject are audited by `identity`, design 9). Later slices add the other review checks and the
// admin edits of design 9.

/** The audit target type of a seller (the file's id is the seller's id). */
export const SELLER_TARGET = 'sellers.seller';

/** What a decrypting read was for (design 9, Hassan M4). */
export const BUSINESS_DETAILS_READ_KINDS = ['review', 'reviewer-details'] as const;
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

/**
 * A reviewer recorded what they read in the register by hand for a pending revision (design 3.4,
 * 9; AC 32): the revision and the outcome code only, never the identifier or a register value.
 */
export const ManualRegisterCheckRecorded = defineAuditAction({
  action: 'sellers.register.manual-check-recorded',
  targetType: SELLER_TARGET,
  actors: ['authenticated'],
  after: {
    revisionId: auditField.id(),
    observedOutcome: auditField.enumOf(OBSERVED_REGISTER_OUTCOMES),
  },
});

/**
 * A seller's minimum order was set, changed or cleared (design 9, 18 decision 8): the amount
 * before and after, absent meaning "no minimum". Not personal data.
 */
export const MinimumOrderChanged = defineAuditAction({
  action: 'sellers.minimum-order.changed',
  targetType: SELLER_TARGET,
  actors: ['authenticated'],
  before: { minimumOrder: auditField.optional(auditField.money()) },
  after: { minimumOrder: auditField.optional(auditField.money()) },
});

/**
 * A seller saved the public texts of the store profile (design 9; slice 12 part 2): the revision
 * made and its number. The text itself, and its hash, are never in the row (design 8.3).
 */
export const StoreProfileSaved = defineAuditAction({
  action: 'sellers.store-profile.saved',
  targetType: SELLER_TARGET,
  actors: ['authenticated'],
  after: { revisionId: auditField.id(), revisionNo: auditField.integer() },
});

/** The images a store can have (design 3.7). */
export const STORE_IMAGE_AUDIT_KINDS = ['logo', 'banner'] as const;

/**
 * A seller set, replaced or removed the logo or the banner of the store (design 9; slice 12
 * part 2). Ids and the kind only: `imageId` is absent while the store has no image of that kind.
 */
export const StoreImageChanged = defineAuditAction({
  action: 'sellers.store-image.changed',
  targetType: SELLER_TARGET,
  actors: ['authenticated'],
  before: { imageId: auditField.optional(auditField.id()) },
  after: {
    kind: auditField.enumOf(STORE_IMAGE_AUDIT_KINDS),
    imageId: auditField.optional(auditField.id()),
  },
});

/** Every audited action of sellers, for its module's registration. */
export const SELLERS_AUDIT_ACTIONS: readonly AuditActionDefinition[] = Object.freeze([
  BusinessDetailsViewed,
  ManualRegisterCheckRecorded,
  MinimumOrderChanged,
  StoreProfileSaved,
  StoreImageChanged,
]);
