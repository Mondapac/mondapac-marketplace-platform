import { declarePermissions, definePermission } from '../../../../platform';

export const ALPHA_ORDERS_VIEW = definePermission('alpha', {
  key: 'alpha.orders.view',
  scope: 'seller',
  protected: false,
});

export const ALPHA_SELLERS_APPROVE = definePermission('alpha', {
  key: 'alpha.sellers.approve',
  scope: 'platform',
  protected: true,
});

export const ALPHA_PERMISSIONS = declarePermissions('alpha', [
  ALPHA_ORDERS_VIEW,
  ALPHA_SELLERS_APPROVE,
]);
