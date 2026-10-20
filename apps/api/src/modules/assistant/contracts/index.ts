// Public contracts of the assistant module (ADR-0008): the permission keys and audit actions.
// Other modules may import only what this file exports, through ../index.ts.
export { ASSISTANT_AUDIT_ACTIONS } from '../domain/audit';
export {
  ASSISTANT_PERMISSIONS,
  ASSISTANT_SETTINGS_MANAGE,
  ASSISTANT_SETTINGS_VIEW,
} from './permissions';
