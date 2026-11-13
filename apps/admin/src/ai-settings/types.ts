// Answers and keys of the Market's AI settings routes (apps/api settings and catalog modules,
// AIS-03). The panel follows what the API answers; it decides nothing.

export const AI_VIEW_PERMISSION = 'settings.ai.view';
export const AI_MANAGE_PERMISSION = 'settings.ai.manage';

export const AI_SETTINGS_PATH = 'settings/admin/ai';
export const MODEL_SETUP_PATH = 'catalog/admin/description-writer/model-setup';

export const WRITER_CODE = 'ai-description-writer';
export const TIER_CODE = 'ai-description-writer-tier';

export const SWITCH_VALUES = ['off', 'on'] as const;
export const TIER_VALUES = ['fast', 'balanced'] as const;
export type SwitchValue = (typeof SWITCH_VALUES)[number];
export type TierValue = (typeof TIER_VALUES)[number];

export interface AiSetting {
  readonly code: string;
  readonly value: string;
  /** 0 while the default is in force, then 1, 2, ... per change. */
  readonly version: number;
  readonly updatedAt: string | null;
}

export interface AiSettingsAnswer {
  readonly settings: readonly AiSetting[];
}

/** What the server is configured with: never the key itself, only whether one is set. */
export interface ModelSetup {
  readonly killSwitch: boolean;
  readonly keyConfigured: boolean;
  readonly models: { readonly fast: string | null; readonly balanced: string | null };
}

const DEFAULTS: Readonly<Record<string, AiSetting>> = {
  [WRITER_CODE]: { code: WRITER_CODE, value: 'off', version: 0, updatedAt: null },
  [TIER_CODE]: { code: TIER_CODE, value: 'fast', version: 0, updatedAt: null },
};

/** One row of an answer, or its default (off, fast) when the API did not name it. */
export function settingOf(answer: AiSettingsAnswer, code: string): AiSetting {
  return (
    answer.settings.find((row) => row.code === code) ??
    DEFAULTS[code] ?? { code, value: '', version: 0, updatedAt: null }
  );
}

export const isSwitchValue = (value: string): value is SwitchValue =>
  (SWITCH_VALUES as readonly string[]).includes(value);
export const isTierValue = (value: string): value is TierValue =>
  (TIER_VALUES as readonly string[]).includes(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** A model setup answer checked, or null when it is not what the panel expects. */
export function modelSetupOf(value: unknown): ModelSetup | null {
  if (!isRecord(value) || !isRecord(value['models'])) return null;
  const { killSwitch, keyConfigured, models } = value;
  const name = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  if (typeof killSwitch !== 'boolean' || typeof keyConfigured !== 'boolean') return null;
  return {
    killSwitch,
    keyConfigured,
    models: { fast: name(models['fast']), balanced: name(models['balanced']) },
  };
}

/** The settings answer checked: a list of rows with a code, a text value and a whole version. */
export function settingsAnswerOf(value: unknown): AiSettingsAnswer | null {
  if (!isRecord(value) || !Array.isArray(value['settings'])) return null;
  const rows: AiSetting[] = [];
  for (const row of value['settings'] as unknown[]) {
    if (
      !isRecord(row) ||
      typeof row['code'] !== 'string' ||
      typeof row['value'] !== 'string' ||
      !Number.isInteger(row['version'])
    ) {
      return null;
    }
    rows.push({
      code: row['code'],
      value: row['value'],
      version: row['version'] as number,
      updatedAt: typeof row['updatedAt'] === 'string' ? row['updatedAt'] : null,
    });
  }
  return { settings: rows };
}
