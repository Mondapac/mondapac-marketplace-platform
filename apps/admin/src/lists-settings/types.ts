// Answers and keys of the Market settings routes (apps/api settings module, ADR-0040). The panel
// follows what the API answers; it decides nothing.

export const SETTINGS_VIEW_PERMISSION = 'settings.market-setting.view';
export const SETTINGS_MANAGE_PERMISSION = 'settings.market-setting.manage';

export const SETTINGS_PATH = 'settings/admin/market-settings';

export const LIST_PAGING_CODE = 'list-paging';
export const LIST_PAGING_VALUES = ['pages', 'prev-next'] as const;
export type ListPagingValue = (typeof LIST_PAGING_VALUES)[number];

export interface MarketSetting {
  readonly code: string;
  readonly value: string;
  /** 0 while the default is in force, then 1, 2, ... per change. */
  readonly version: number;
  readonly updatedAt: string | null;
}

export interface MarketSettingsAnswer {
  readonly settings: readonly MarketSetting[];
}

/** The list paging row of an answer, or the default when the API did not name it. */
export function listPagingOf(answer: MarketSettingsAnswer): MarketSetting {
  return (
    answer.settings.find((setting) => setting.code === LIST_PAGING_CODE) ?? {
      code: LIST_PAGING_CODE,
      value: 'pages',
      version: 0,
      updatedAt: null,
    }
  );
}

export const isListPagingValue = (value: string): value is ListPagingValue =>
  (LIST_PAGING_VALUES as readonly string[]).includes(value);
