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

// The playground (G5d): one synthetic sample on two models side by side. Ids only go to the
// API; what comes back is plain text, rendered as text and never as HTML.

export const PLAYGROUND_SAMPLES_PATH = `${MODELS_PATH}/playground/samples`;
export const PLAYGROUND_PATH = `${MODELS_PATH}/playground`;

export interface PlaygroundSample {
  readonly id: string;
  readonly label: string;
}

export interface PlaygroundSuite {
  readonly capability: string;
  readonly setVersion: string;
  readonly samples: readonly PlaygroundSample[];
}

export interface PlaygroundAnswer {
  readonly family: string;
  /** `ok`, a failure of the call, or `closed-*` when evaluations are closed. */
  readonly outcome: string;
  readonly text: string | null;
  readonly checks: readonly string[];
  readonly costMicroUsd: number;
  readonly latencyMs: number | null;
  readonly route: string | null;
}

export function playgroundSuitesOf(value: unknown): readonly PlaygroundSuite[] | null {
  if (!isRecord(value) || !Array.isArray(value['suites'])) return null;
  const suites: PlaygroundSuite[] = [];
  for (const item of value['suites'] as unknown[]) {
    if (
      !isRecord(item) ||
      typeof item['capability'] !== 'string' ||
      typeof item['setVersion'] !== 'string' ||
      !Array.isArray(item['samples'])
    ) {
      return null;
    }
    const samples: PlaygroundSample[] = [];
    for (const sample of item['samples'] as unknown[]) {
      if (!isRecord(sample) || typeof sample['id'] !== 'string') return null;
      samples.push({
        id: sample['id'],
        label: typeof sample['label'] === 'string' ? sample['label'] : sample['id'],
      });
    }
    suites.push({ capability: item['capability'], setVersion: item['setVersion'], samples });
  }
  return suites;
}

export function playgroundAnswersOf(value: unknown): readonly PlaygroundAnswer[] | null {
  if (!isRecord(value) || !Array.isArray(value['answers'])) return null;
  const answers: PlaygroundAnswer[] = [];
  for (const item of value['answers'] as unknown[]) {
    if (
      !isRecord(item) ||
      typeof item['family'] !== 'string' ||
      typeof item['outcome'] !== 'string' ||
      typeof item['costMicroUsd'] !== 'number'
    ) {
      return null;
    }
    answers.push({
      family: item['family'],
      outcome: item['outcome'],
      text: typeof item['text'] === 'string' ? item['text'] : null,
      checks: Array.isArray(item['checks'])
        ? (item['checks'] as unknown[]).filter(
            (check): check is string => typeof check === 'string',
          )
        : [],
      costMicroUsd: item['costMicroUsd'],
      latencyMs: typeof item['latencyMs'] === 'number' ? item['latencyMs'] : null,
      route: typeof item['route'] === 'string' ? item['route'] : null,
    });
  }
  return answers;
}

/** The families the server lists as usable for any task, each once, in the order listed. */
export function usableFamilies(answer: ModelsAnswer): readonly string[] {
  const seen = new Set<string>();
  for (const list of Object.values(answer.options)) {
    for (const option of list) if (option.problem === null) seen.add(option.family);
  }
  return [...seen];
}
