// Public contracts of the notifications module (ADR-0008): the permission keys and audit actions.
// Other modules may import only what this file exports, through ../index.ts.
export { NOTIFICATIONS_AUDIT_ACTIONS } from '../domain/audit';
export {
  NOTIFICATIONS_PERMISSIONS,
  NOTIFICATIONS_SUPPORT_CONTACT_MANAGE,
  NOTIFICATIONS_SUPPORT_CONTACT_VIEW,
} from './permissions';
export { SUPPORT_CONTACT_FACADE, type SupportContactFacade } from './support-contact.facade';
