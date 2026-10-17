import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of certification (certification design 7.1; platform-foundations 6.1).
// A key is declared with the first use case that names it, together with identity's seed of the
// default roles that receive it. The platform keys (review, approve, revoke, ...) arrive with the
// review package.

/**
 * Read the seller's own certificates, their status codes and reasons, and their own documents
 * (design 7.1). Seller scope: the Seller Owner holds every seller key; Store Manager and
 * Catalogue and Stock receive it by identity's seed.
 */
export const CERTIFICATION_OWN_CERTIFICATE_VIEW = definePermission('certification', {
  key: 'certification.own-certificate.view',
  scope: 'seller',
  protected: false,
});

/**
 * Create, edit, upload, submit and withdraw the seller's own certificates (design 7.1; brief s5,
 * AC 10). Seller scope; the Store Manager receives it by identity's seed.
 */
export const CERTIFICATION_OWN_CERTIFICATE_MANAGE = definePermission('certification', {
  key: 'certification.own-certificate.manage',
  scope: 'seller',
  protected: false,
});

export const CERTIFICATION_PERMISSIONS = declarePermissions('certification', [
  CERTIFICATION_OWN_CERTIFICATE_VIEW,
  CERTIFICATION_OWN_CERTIFICATE_MANAGE,
]);
