// Public contracts of the security module (ADR-0008): the permission keys and audit actions.
// Other modules may import only what this file exports, through ../index.ts.
export { SECURITY_AUDIT_ACTIONS } from '../domain/audit';
export {
  SECURITY_ALERTS_SAVED_FILTER_SHARE,
  SECURITY_PERMISSIONS,
  SECURITY_RESPOND,
  SECURITY_VIEW,
} from './permissions';
export {
  SECURITY_WORK_QUEUE_FACADE,
  type SecurityWorkQueueFacade,
} from './security-work-queue.facade';
