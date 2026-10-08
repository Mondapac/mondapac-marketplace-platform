import type { SeededRole } from '../../application/ports/role-seed';

/**
 * The seller scope's roles (identity design 5.6), version 1. Slice 5 seeds the system role, the
 * Seller Owner, whom every self-registered seller's founder receives (5.5). The default roles
 * (Store Manager and the rest) join with slice 8a. A change of a role here raises its version.
 */
export const SELLER_ROLES_SEED: readonly SeededRole[] = [
  {
    scope: 'seller',
    kind: 'system',
    seedCode: 'seller-owner',
    seedVersion: 1,
    nameKey: 'identity.role.seller-owner',
    permissionKeys: [],
  },
];
