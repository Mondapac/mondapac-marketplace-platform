// Answers of the buyer assistant settings routes (apps/api admin-assistant-settings.controller.ts).

export const ASSISTANT_VIEW_PERMISSION = 'assistant.settings.view';
export const ASSISTANT_MANAGE_PERMISSION = 'assistant.settings.manage';
export const ASSISTANT_SETTINGS_PATH = 'assistant/admin/settings';

export const AUDIENCES = ['internal', 'percent', 'all'] as const;
export const SCOPES = ['read-only', 'cart-suggestions'] as const;
export const MODEL_TIERS = ['fast', 'balanced'] as const;
export const USER_GROUPS = ['guests-and-customers', 'customers-only'] as const;
export const RETENTIONS = ['none', '30-days', '12-months'] as const;
export const REPLY_LANGUAGES = ['buyer', 'english'] as const;
export const SUPPORT_HANDOFFS = ['email-link', 'in-panel-form'] as const;

export type Audience = (typeof AUDIENCES)[number];
export type Scope = (typeof SCOPES)[number];
export type ModelTier = (typeof MODEL_TIERS)[number];
export type UserGroup = (typeof USER_GROUPS)[number];
export type Retention = (typeof RETENTIONS)[number];
export type ReplyLanguage = (typeof REPLY_LANGUAGES)[number];
export type SupportHandoff = (typeof SUPPORT_HANDOFFS)[number];

/** Every field the PUT takes; the API replaces all of them at once. */
export interface AssistantSettings {
  readonly enabled: boolean;
  readonly audience: Audience;
  /** 1 to 100 when `audience` is `percent`, else null. */
  readonly audiencePercent: number | null;
  readonly scope: Scope;
  readonly modelTier: ModelTier;
  readonly users: UserGroup;
  readonly guestMessageLimit: number;
  readonly customerMessageLimit: number;
  readonly retention: Retention;
  readonly replyLanguage: ReplyLanguage;
  readonly dailySpendCapUsdCents: number;
  readonly monthlySpendCapUsdCents: number;
  readonly supportHandoff: SupportHandoff;
  /** null: the storefront shows its own default text. */
  readonly welcomeText: string | null;
}

export interface AssistantSettingsAnswer {
  /** 0 while the built-in defaults are in force, then 1, 2, ... per change. */
  readonly version: number;
  readonly settings: AssistantSettings;
  /** The key itself never leaves the server. */
  readonly apiKey: 'set' | 'not-set';
  /** The model the server configures for each tier; null when none is. */
  readonly models: readonly { readonly tier: ModelTier; readonly modelId: string | null }[];
  /** Options shown but not selectable yet. */
  readonly unavailableOptions: {
    readonly scope: readonly Scope[];
    readonly supportHandoff: readonly SupportHandoff[];
  };
}
