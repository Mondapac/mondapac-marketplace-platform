import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of inventory (inventory design 6; platform-foundations 6.1). Slice 1,
// part 2 declares the two seller-scope keys the source use cases name. The Seller Owner holds
// every seller key by definition; the default roles that receive them are identity's seed
// (inventory design 6, brief s11). The other keys of design 6 (`inventory.stock.edit`,
// `inventory.settings.edit`, the platform-scope `inventory.seller-stock.view`) join with the
// first use case that names them.

/** See the stock locations and the stock of the seller's own Offers. */
export const INVENTORY_STOCK_VIEW = definePermission('inventory', {
  key: 'inventory.stock.view',
  scope: 'seller',
  protected: false,
});

/** Add, edit and reorder the seller's stock locations. */
export const INVENTORY_SOURCE_EDIT = definePermission('inventory', {
  key: 'inventory.source.edit',
  scope: 'seller',
  protected: false,
});

export const INVENTORY_PERMISSIONS = declarePermissions('inventory', [
  INVENTORY_STOCK_VIEW,
  INVENTORY_SOURCE_EDIT,
]);
