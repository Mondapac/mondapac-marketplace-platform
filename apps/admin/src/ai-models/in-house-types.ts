// Answers, codes and bounds of the in-house model (Mondapac Intelligence) settings route (apps/api
// settings module, AI Gateway G6b). The panel follows what the API answers; it decides nothing:
// every rule below is checked again on the server, and a refused field comes back by its code.

import { settingsOf, type GatewaySetting } from '../ai-gateway/types.ts';
import { MODELS_PATH, TASKS, type Task } from './types.ts';

export const IN_HOUSE_PATH = `${MODELS_PATH}/in-house`;

export const STAGES = ['off', 'shadow', 'percent', 'default'] as const;
export type Stage = (typeof STAGES)[number];

export const stageCode = (task: Task): string => `ai-in-house-stage-${task}`;
export const modelCode = (task: Task): string => `ai-in-house-model-${task}`;
export const shadowCode = (task: Task): string => `ai-in-house-shadow-${task}`;
export const rolloutCode = (task: Task): string => `ai-in-house-rollout-${task}`;
export const ERRORS_CODE = 'ai-in-house-rollback-errors';
export const GUARD_CODE = 'ai-in-house-rollback-guard';
export const SAMPLE_CODE = 'ai-in-house-rollback-sample';

/** The API's defaults, shown while a setting has never been changed (version 0, empty value). */
export const DEFAULTS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    TASKS.flatMap((task) => [
      [stageCode(task), 'off'],
      [modelCode(task), 'none'],
      [shadowCode(task), '0'],
      [rolloutCode(task), '0'],
    ]),
  ),
  [ERRORS_CODE]: '20',
  [GUARD_CODE]: '10',
  [SAMPLE_CODE]: '200',
};

/** Every in-house setting, in the order the page and its history list show them. */
export const IN_HOUSE_CODES: readonly string[] = [
  ...TASKS.flatMap((task) => [
    stageCode(task),
    modelCode(task),
    shadowCode(task),
    rolloutCode(task),
  ]),
  ERRORS_CODE,
  GUARD_CODE,
  SAMPLE_CODE,
];

// The server's bounds (platform/ai own-model/in-house-stage.ts), repeated only to help the admin
// type a value; the server checks them again.
export const SHADOW_MAX = 100;
export const ROLLOUT_MAX = 99;
/** Rollback limits are stored in tenths of a percent: 1 (0.1 %) to 50 (5 %, the server ceiling). */
export const LIMIT_MIN_PERMILLE = 1;
export const LIMIT_MAX_PERMILLE = 50;
export const SAMPLE_MIN = 100;
export const SAMPLE_MAX = 10_000;

export interface InHouseOption {
  readonly family: string;
  /** Why it cannot be the task type's model in a stage other than off now, or null. */
  readonly problem: string | null;
}

export interface InHouseAnswer {
  readonly settings: readonly GatewaySetting[];
  readonly options: Readonly<Record<string, readonly InHouseOption[]>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export function inHouseAnswerOf(value: unknown): InHouseAnswer | null {
  if (!isRecord(value) || !isRecord(value['options'])) return null;
  const settings = settingsOf(value);
  if (settings === null) return null;
  const options: Record<string, InHouseOption[]> = {};
  for (const [task, list] of Object.entries(value['options'])) {
    if (!Array.isArray(list)) return null;
    const rows: InHouseOption[] = [];
    for (const item of list as unknown[]) {
      if (!isRecord(item) || typeof item['family'] !== 'string') return null;
      rows.push({
        family: item['family'],
        problem: typeof item['problem'] === 'string' ? item['problem'] : null,
      });
    }
    options[task] = rows;
  }
  return { settings, options };
}

/** The value in force for a code: the stored one, or the API's default. */
export function valueOf(rows: readonly GatewaySetting[], code: string): string {
  const stored = rows.find((row) => row.code === code)?.value ?? '';
  return stored === '' ? (DEFAULTS[code] ?? '') : stored;
}

export const isStage = (value: string): value is Stage =>
  (STAGES as readonly string[]).includes(value);

/** "2.5" for 25 tenths of a percent. */
export const percentOfPermille = (permille: string): string => {
  const n = Number(permille);
  return Number.isInteger(n) ? (n / 10).toFixed(1) : permille;
};

/**
 * Tenths of a percent for what the admin typed ("2", "2.5" or "2,5"), or null when it is not a
 * number with at most one decimal inside the server's bounds.
 */
export function permilleOfPercent(typed: string): string | null {
  const text = typed.trim().replace(',', '.');
  if (!/^\d{1,2}(\.\d)?$/.test(text)) return null;
  const permille = Math.round(Number(text) * 10);
  if (permille < LIMIT_MIN_PERMILLE || permille > LIMIT_MAX_PERMILLE) return null;
  return String(permille);
}

/** The whole number the admin typed if it is within `min` and `max`, else null. */
export function wholeWithin(typed: string, min: number, max: number): string | null {
  const text = typed.trim();
  if (!/^\d{1,5}$/.test(text)) return null;
  const n = Number(text);
  return n < min || n > max ? null : String(n);
}
