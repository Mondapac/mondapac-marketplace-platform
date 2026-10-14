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
    // design 6.2, Hassan M4); the seed contract test checks the pairing.
    seedVersion: 4,
    nameKey: 'identity.role.onboarding-compliance',
    permissionKeys: [
      'identity.seller-access.view',
      'identity.seller-access.approve',
      'identity.seller-access.suspend',
      'identity.seller-account.create',
      'sellers.seller-file.review',
      'sellers.seller.view',
      'sellers.business-details.view',
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
    // the Platform Administrator grants it (pricing H4).
    seedVersion: 4,
    nameKey: 'identity.role.catalogue-moderator',
    permissionKeys: [
      'identity.seller-access.view',
      'catalog.platform-product.edit',
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
    // Version 3 adds `pricing.price-hold.view` (pricing design 5.3, slice 4).
    seedVersion: 3,
    nameKey: 'identity.role.viewer',
    permissionKeys: [
      'identity.seller-access.view',
      'identity.customer-account.view',
      'identity.admin-account.view',
      'identity.platform-role.view',
      'sellers.seller.view',
      'pricing.price-hold.view',
    ],
  },
];
