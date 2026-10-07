import { declarePermissions, definePermission } from '../../../../platform';

export const BETA_ORDERS_VIEW = definePermission('beta', {
  key: 'beta.orders.view',
  scope: 'seller',
  protected: false,
});

export const BETA_SELLERS_APPROVE = definePermission('beta', {
  key: 'beta.sellers.approve',
  scope: 'platform',
  protected: true,
});

/** On the fixture's retired list: declaring it again is refused. */
export const BETA_THINGS_PURGE = definePermission('beta', {
  key: 'beta.things.purge',
  scope: 'platform',
  protected: false,
});

export const BETA_PERMISSIONS = declarePermissions('beta', [
  BETA_ORDERS_VIEW,
  BETA_SELLERS_APPROVE,
  BETA_THINGS_PURGE,
]);
