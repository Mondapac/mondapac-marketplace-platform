// Public contracts of the settings module (ADR-0008): the permission keys, the audit actions and
// the setting definitions. Other modules may import only what this file exports, through
// ../index.ts.
export { SETTINGS_AUDIT_ACTIONS } from '../domain/audit';
export {
  LIST_PAGING_CODE,
  LIST_PAGING_VALUES,
  SETTING_DEFINITIONS,
  type ListPaging,
  type SettingDefinition,
} from '../domain/definitions';
export {
  SETTINGS_MARKET_SETTING_MANAGE,
  SETTINGS_MARKET_SETTING_VIEW,
  SETTINGS_PERMISSIONS,
} from './permissions';
