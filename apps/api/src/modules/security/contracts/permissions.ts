import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of the security module (security centre design section 3, decision
// T8: the page has its own permissions). Package 2 declares the first two; security.actions and
// security.addons come with packages 3 and 6, payments.kill with package 3.

/** See the security centre: alerts, their timeline, the rules' last run and the on-call view. */
export const SECURITY_VIEW = definePermission('security', {
  key: 'security.centre.view',
  scope: 'platform',
  protected: false,
});

/**
 * Acknowledge an alert of any severity and resolve s2 to s4 alerts. An s1 alert is resolved only
 * by the incident commander or the security owner of the on-call roster (design D2).
 */
export const SECURITY_RESPOND = definePermission('security', {
  key: 'security.alerts.respond',
  scope: 'platform',
  protected: false,
});

/**
 * Share a saved filter of the alert list with every admin who can see the security centre. A
 * private filter needs no key beyond the view key; sharing is its own protected key so a filter
 * that frames what the on-call sees is not shared by whoever can only read alerts.
 */
export const SECURITY_ALERTS_SAVED_FILTER_SHARE = definePermission('security', {
  key: 'security.alerts-saved-filter.share',
  scope: 'platform',
  protected: true,
});

export const SECURITY_PERMISSIONS = declarePermissions('security', [
  SECURITY_ALERTS_SAVED_FILTER_SHARE,
  SECURITY_RESPOND,
  SECURITY_VIEW,
]);
