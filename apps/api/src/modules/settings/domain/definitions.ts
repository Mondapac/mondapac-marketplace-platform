// The admin-editable Market settings (ADR-0026), declared in code: code, allowed values, the
// value in force while no admin has changed it, and the safe value used when the store cannot be
// read. Adding a setting is adding a definition here (and its translation keys in the panels).

export const LIST_PAGING_CODE = 'list-paging';

/** `pages`: page numbers with the total. `prev-next`: Previous and Next, no jump to a page. */
export const LIST_PAGING_VALUES = ['pages', 'prev-next'] as const;
export type ListPaging = (typeof LIST_PAGING_VALUES)[number];

export const CART_MODE_CODE = 'cart-mode';

/**
 * How a buyer's cart treats several stores. `multi-store`: one cart may hold lines from several
 * stores (one order per store). `single-store`: a cart holds one store only. This setting only
 * stores the choice; the cart and ordering read it in their own packages.
 */
export const CART_MODE_VALUES = ['multi-store', 'single-store'] as const;
export type CartMode = (typeof CART_MODE_VALUES)[number];

export const AI_DESCRIPTION_WRITER_CODE = 'ai-description-writer';

/**
 * Whether the AI description writer (AIS-03, admin and seller) may be used in the Market. Off by
 * default and when the store cannot be read (ADR-0019 R8, ADR-0026 decision 5). Turned on only
 * after the real-model evaluation of its prompt version is recorded as passed (decision 9).
 */
export const AI_DESCRIPTION_WRITER_VALUES = ['off', 'on'] as const;
export type AiDescriptionWriter = (typeof AI_DESCRIPTION_WRITER_VALUES)[number];

export const AI_DESCRIPTION_WRITER_TIER_CODE = 'ai-description-writer-tier';

/**
 * Which of the Market's model tiers the writer uses. The model id of each tier, the provider and
 * the key stay server configuration (ADR-0026 decision 9, R7); only the tier is a setting.
 */
export const AI_MODEL_TIER_VALUES = ['fast', 'balanced'] as const;
export type AiModelTierSetting = (typeof AI_MODEL_TIER_VALUES)[number];

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
  {
    code: CART_MODE_CODE,
    values: CART_MODE_VALUES,
    defaultValue: 'multi-store',
    // An unreadable store keeps today's behaviour; the cart's own read decides what to enforce.
    safeValue: 'multi-store',
  },
  {
    code: AI_DESCRIPTION_WRITER_CODE,
    values: AI_DESCRIPTION_WRITER_VALUES,
    defaultValue: 'off',
    safeValue: 'off',
  },
  {
    code: AI_DESCRIPTION_WRITER_TIER_CODE,
    values: AI_MODEL_TIER_VALUES,
    defaultValue: 'fast',
    // The cheaper tier.
    safeValue: 'fast',
  },
]);

export const SETTING_CODES: readonly string[] = SETTING_DEFINITIONS.map((d) => d.code);

export function findDefinition(code: unknown): SettingDefinition | null {
  return SETTING_DEFINITIONS.find((definition) => definition.code === code) ?? null;
}
