// The admin-editable Market settings (ADR-0026), declared in code: code, allowed values, the
// value in force while no admin has changed it, and the safe value used when the store cannot be
// read. Adding a setting is adding a definition here (and its translation keys in the panels).

export const LIST_PAGING_CODE = 'list-paging';

/** `pages`: page numbers with the total. `prev-next`: Previous and Next, no jump to a page. */
export const LIST_PAGING_VALUES = ['pages', 'prev-next'] as const;
export type ListPaging = (typeof LIST_PAGING_VALUES)[number];

export interface SettingDefinition {
  readonly code: string;
  readonly values: readonly string[];
  /** In force while the Market has no row. */
  readonly defaultValue: string;
  /** Used when the store cannot be read: restrictive and cheap, never a Market choice. */
  readonly safeValue: string;
}

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = Object.freeze([
  {
    code: LIST_PAGING_CODE,
    values: LIST_PAGING_VALUES,
    defaultValue: 'pages',
    safeValue: 'prev-next',
  },
]);

export const SETTING_CODES: readonly string[] = SETTING_DEFINITIONS.map((d) => d.code);

export function findDefinition(code: unknown): SettingDefinition | null {
  return SETTING_DEFINITIONS.find((definition) => definition.code === code) ?? null;
}
