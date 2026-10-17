import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of tax. Tax strategies decide how much tax a customer is charged, so
// changing them is a protected platform key (only the Platform Administrator holds it by
// definition); so is reading them, which keeps the default roles (and their seed) unchanged.

/** See the Market's tax strategies and which one is active. */
export const TAX_STRATEGY_VIEW = definePermission('tax', {
  key: 'tax.strategy.view',
  scope: 'platform',
  protected: true,
});

/** Define, change, delete and activate tax strategies. */
export const TAX_STRATEGY_MANAGE = definePermission('tax', {
  key: 'tax.strategy.manage',
  scope: 'platform',
  protected: true,
});

export const TAX_PERMISSIONS = declarePermissions('tax', [TAX_STRATEGY_MANAGE, TAX_STRATEGY_VIEW]);
