import type { SeededRole } from '../../application/ports/role-seed';

/**
 * The seller scope's roles (identity design 5.6). Slice 5 seeded the system role, the Seller
 * Owner, whom every self-registered seller's founder receives (5.5). Slice 8a-1 adds the default
 * seller roles of 5.6: shared rows of the Market (no seller id, R9) that no use case of a seller
 * can change. Only the Store Manager holds keys in Phase 2; the others receive theirs at their
 * modules' gates (R10). No default role lists a protected key: in Phase 2 protected seller keys
 * are not grantable at all (5.4 R11), so only the Seller Owner manages the team.
 *
 * **A change of a role here raises its `seedVersion`** (see `platform-roles.seed.ts`).
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
  {
    // Runs the shop day to day without owning it.
    scope: 'seller',
    kind: 'default',
    seedCode: 'store-manager',
    seedVersion: 2,
    nameKey: 'identity.role.store-manager',
    permissionKeys: [
      'identity.team-member.view',
      'identity.seller-role.view',
      'catalog.own-product.view',
    ],
  },
  {
    // V2: accepts, packs and hands over orders. Keys at the ordering and shipping gates.
    scope: 'seller',
    kind: 'default',
    seedCode: 'order-fulfilment',
    seedVersion: 1,
    nameKey: 'identity.role.order-fulfilment',
    permissionKeys: [],
  },
  {
    // Maintains offers, prices and stock. Keys at the catalog, pricing and inventory gates.
    scope: 'seller',
    kind: 'default',
    seedCode: 'catalogue-stock',
    seedVersion: 2,
    nameKey: 'identity.role.catalogue-stock',
    permissionKeys: ['catalog.own-product.view'],
  },
  {
    // Answers customers, handles returns.
    scope: 'seller',
    kind: 'default',
    seedCode: 'customer-service',
    seedVersion: 2,
    nameKey: 'identity.role.customer-service',
    permissionKeys: ['catalog.own-product.view'],
  },
  {
    // Reads earnings, statements and invoices.
    scope: 'seller',
    kind: 'default',
    seedCode: 'bookkeeper',
    seedVersion: 1,
    nameKey: 'identity.role.bookkeeper',
    permissionKeys: [],
  },
];
