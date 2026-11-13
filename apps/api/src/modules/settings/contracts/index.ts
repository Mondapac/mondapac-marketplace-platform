// Public contracts of the settings module (ADR-0008): the permission keys, the audit actions and
// the setting definitions. Other modules may import only what this file exports, through
// ../index.ts.
export { SETTINGS_AUDIT_ACTIONS } from '../domain/audit';
export {
  CART_MODE_CODE,
  CART_MODE_VALUES,
  LIST_PAGING_CODE,
  LIST_PAGING_VALUES,
  SETTING_DEFINITIONS,
  type CartMode,
  type ListPaging,
  type SettingDefinition,
} from '../domain/definitions';
export {
  SETTINGS_CART_MODE_MANAGE,
  SETTINGS_CART_MODE_VIEW,
  SETTINGS_LIST_PAGING_MANAGE,
  SETTINGS_LIST_PAGING_VIEW,
  SETTINGS_PERMISSIONS,
} from './permissions';
