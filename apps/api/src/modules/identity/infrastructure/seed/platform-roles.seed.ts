import type { SeededRole } from '../../application/ports/role-seed';

/**
 * The platform scope's roles (identity design 5.6). Slice 5 seeded the system role, the
 * Platform Administrator, so the first admin of a Market (7.4, slice 7) has a role to receive.
 * Slice 8a-1 adds the default admin roles of 5.6 with their Phase 2 keys: the owner's proposal
 * (assumptions A1 to A5 of `panels-ux-strategy.md`); each later module's gate decides which of
 * them receive its keys (R10). A default role never lists a protected key.
 *
 * **A change of a role here raises its `seedVersion`.** The seed routine applies a newer version
 * to the stored row key by key, with an `identity.role.seed-applied` audit row; it never applies
 * an older one. No admin account is created by any seed (slice 7 owns the first admin).
 */
export const PLATFORM_ROLES_SEED: readonly SeededRole[] = [
  {
    scope: 'platform',
    kind: 'system',
    seedCode: 'platform-administrator',
    seedVersion: 1,
    nameKey: 'identity.role.platform-administrator',
    permissionKeys: [],
  },
  {
    // A1: review and decide seller applications.
    scope: 'platform',
    kind: 'default',
    seedCode: 'onboarding-compliance',
    // Version 2 adds `sellers.seller-file.review` (sellers design 6.1: record review checks, run a
    // re-lookup, record a manual register check); a Market seeded at version 1 gets it on its
    // next SeedRoles run. Version 3 adds `sellers.seller.view` (the admin seller list, sellers
    // slice 6). Version 4 adds `sellers.business-details.view` (the review page, which decrypts
    // business data, sellers slice 7a-read): every default role that holds
    // `identity.seller-access.approve` holds it too, because the gate has no "any of" (sellers
    // design 6.2, Hassan M4); the seed contract test checks the pairing. Version 5 adds
    // `certification.seller-certificate.view` and `.review` (certification slice 7: the review
    // queue, the review page, checks, scope and issuer confirmation). All three decisions (approve,
    // request changes, decline) need the protected `.approve`, which is not listed: a default role
    // never lists a protected key (R11), the Platform Administrator grants it. Version 6 adds
    // `certification.issuer.view` (certification slice 6: the issuer request queue and the typed
    // name); answering needs the protected `certification.issuer.edit`, not listed.
    seedVersion: 6,
    nameKey: 'identity.role.onboarding-compliance',
    permissionKeys: [
      'identity.seller-access.view',
      'identity.seller-access.approve',
      'identity.seller-access.suspend',
      'identity.seller-account.create',
      'sellers.seller-file.review',
      'sellers.seller.view',
      'sellers.business-details.view',
      'certification.seller-certificate.view',
      'certification.seller-certificate.review',
      'certification.issuer.view',
    ],
  },
  {
    // A2: review products and revisions.
    scope: 'platform',
    kind: 'default',
    seedCode: 'catalogue-moderator',
    // Version 2 adds `catalog.platform-product.edit` (catalog design 8.1, CAT-41; request I-1,
    // slice I-1a: create, edit, submit and revert PLATFORM products); a Market seeded at version
    // 1 gets it on its next SeedRoles run. Version 3 adds `sellers.seller.view`. Version 4 adds
    // `pricing.price-hold.view` (pricing design 5.3, slice 4: the review queue). The protected
    // `pricing.price-hold.decide` is not listed: a default role never lists a protected key (R11),
    // the Platform Administrator grants it (pricing H4). Version 5 adds `catalog.product.view` and
    // `catalog.product.approve` (catalog design 8.1: the Offer review queue, approve and request
    // changes; both unprotected).
    seedVersion: 5,
    nameKey: 'identity.role.catalogue-moderator',
    permissionKeys: [
      'identity.seller-access.view',
      'catalog.platform-product.edit',
      'catalog.product.view',
      'catalog.product.approve',
      'sellers.seller.view',
      'pricing.price-hold.view',
    ],
  },
  {
    // A3: help sellers and customers day to day.
    scope: 'platform',
    kind: 'default',
    seedCode: 'operations-support',
    // Version 2 adds `sellers.seller.view` (the admin seller list, sellers slice 6).
    seedVersion: 2,
    nameKey: 'identity.role.operations-support',
    permissionKeys: [
      'identity.seller-access.view',
      'identity.customer-account.view',
      'identity.customer-account.disable',
      'identity.seller-account.reset-second-factor',
      'sellers.seller.view',
    ],
  },
  {
    // A4: payouts, commission, ledgers.
    scope: 'platform',
    kind: 'default',
    seedCode: 'finance',
    // Version 2 adds `sellers.seller.view` (the admin seller list, sellers slice 6).
    seedVersion: 2,
    nameKey: 'identity.role.finance',
    permissionKeys: ['identity.seller-access.view', 'sellers.seller.view'],
  },
  {
    // Read-only access for oversight: every unprotected `view` key of the platform scope.
    scope: 'platform',
    kind: 'default',
    seedCode: 'viewer',
    // Version 2 adds `sellers.seller.view`, an unprotected `view` key of the platform scope
    // (sellers design 6.1, slice 6). The other default roles of 6.1 got it in their version bumps.
    // Version 3 adds `pricing.price-hold.view` (pricing design 5.3, slice 4). Version 4 adds
    // `catalog.product.view`, an unprotected `view` key of the platform scope (catalog design 8.1).
    // Version 5 adds `ordering.order.view`, likewise unprotected (Phase 5 package 1).
    // Version 6 adds `shipping.flat-fee.view`, likewise unprotected (Phase 5 package 4).
    // Version 7 adds `commission-payouts.settlement.view`, likewise unprotected (Phase 5 package 5).
    // Version 8 adds `payments.connected-account.view`, likewise unprotected (Phase 5 package 3).
    // Version 9 adds `notifications.support-contact.view`, likewise unprotected (support contact).
    // Version 10 adds `certification.seller-certificate.view`, likewise unprotected (certification
    // slice 7). The review key reads decrypted certificate fields and is not a viewer key.
    seedVersion: 10,
    nameKey: 'identity.role.viewer',
    permissionKeys: [
      'identity.seller-access.view',
      'identity.customer-account.view',
      'identity.admin-account.view',
      'identity.platform-role.view',
      'catalog.product.view',
      'sellers.seller.view',
      'pricing.price-hold.view',
      'ordering.order.view',
      'shipping.flat-fee.view',
      'commission-payouts.settlement.view',
      'payments.connected-account.view',
      'notifications.support-contact.view',
      'certification.seller-certificate.view',
    ],
  },
  {
    // Reviews seller certificates (certification slice 7). Reads the seller's store name and
    // business details for the holder-name check and records checks, scope and confirmation. It
    // cannot decide: approve, request changes and decline all need the protected
    // `certification.seller-certificate.approve`, which the Platform Administrator grants in a
    // custom role (do not add it here). Version 2 adds `certification.issuer.view` (certification
    // slice 6: the issuer request queue); the protected `certification.issuer.edit` is not listed.
    scope: 'platform',
    kind: 'default',
    seedCode: 'certification-reviewer',
    seedVersion: 2,
    nameKey: 'identity.role.certification-reviewer',
    permissionKeys: [
      'identity.seller-access.view',
      'sellers.seller.view',
      'sellers.business-details.view',
      'certification.seller-certificate.view',
      'certification.seller-certificate.review',
      'certification.issuer.view',
    ],
  },
];
