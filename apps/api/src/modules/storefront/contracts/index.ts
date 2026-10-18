// Public contracts of the storefront module (ADR-0008): the permission keys and audit actions.
// Other modules may import only what this file exports, through ../index.ts.
export { STOREFRONT_AUDIT_ACTIONS } from '../domain/audit';
export {
  STOREFRONT_NAVIGATION_APPROVE,
  STOREFRONT_NAVIGATION_EDIT,
  STOREFRONT_PAGE_ARCHIVE,
  STOREFRONT_PAGE_CREATE,
  STOREFRONT_PAGE_EDIT,
  STOREFRONT_PAGE_PUBLISH,
  STOREFRONT_PAGE_READ,
  STOREFRONT_PERMISSIONS,
} from './permissions';
