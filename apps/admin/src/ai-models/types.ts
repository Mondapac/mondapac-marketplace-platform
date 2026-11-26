// Answers and keys of the AI model choice routes (apps/api settings module, AI Gateway G4b). The
// panel follows what the API answers; it decides nothing. Models are only ever chosen among the
// families the API lists for a task type; the panel never types a model id.

import { settingsOf, type GatewaySetting } from '../ai-gateway/types.ts';

export const MODELS_VIEW_PERMISSION = 'settings.ai-gateway.view';
export const MODELS_MANAGE_PERMISSION = 'settings.ai-models.manage';

export const MODELS_PATH = 'settings/admin/ai-models';
export const MODELS_HISTORY_PATH = `${MODELS_PATH}/history`;
export const MODELS_REVERT_PATH = `${MODELS_PATH}/revert`;

export const TASKS = ['chat', 'extract', 'write', 'vision'] as const;
export type Task = (typeof TASKS)[number];

export const listCode = (task: Task): string => `ai-models-${task}`;
export const saverCode = (task: Task): string => `ai-saver-${task}`;
export const SAVER_PERCENT_CODE = 'ai-saver-percent';
export const DEFAULT_SAVER_PERCENT = '80';
export const MAX_FAMILIES = 3;

export const MODEL_CODES: readonly string[] = [
  ...TASKS.flatMap((task) => [listCode(task), saverCode(task)]),
  SAVER_PERCENT_CODE,
];

export interface ModelOption {
  readonly family: string;
  /** Why it cannot be chosen now (unknown-model, region, retired, ...), or null. */
  readonly problem: string | null;
}

export interface ModelsAnswer {
  readonly settings: readonly GatewaySetting[];
  readonly options: Readonly<Record<string, readonly ModelOption[]>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export function modelsAnswerOf(value: unknown): ModelsAnswer | null {
  if (!isRecord(value) || !isRecord(value['options'])) return null;
  const settings = settingsOf(value);
  if (settings === null) return null;
  const options: Record<string, ModelOption[]> = {};
  for (const [task, list] of Object.entries(value['options'])) {
    if (!Array.isArray(list)) return null;
    const rows: ModelOption[] = [];
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

/** The families of a stored list or saver value, in order; empty for `none` or nothing. */
export function familiesOf(value: string): readonly string[] {
  if (value === '' || value === 'none') return [];
  return value.split(',').filter((family) => family !== '');
}

/** The value to save for a list of families. */
export const valueOfFamilies = (families: readonly string[]): string =>
  families.length === 0 ? 'none' : families.join(',');

/** Moves the item at `index` by `delta` places; the list is returned unchanged at its ends. */
export function moved<T>(list: readonly T[], index: number, delta: -1 | 1): readonly T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item as T);
  return next;
}
