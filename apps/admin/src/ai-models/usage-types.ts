// The answer of `GET settings/admin/ai-models/usage` (apps/api settings module, AI Gateway G5e):
// the last 30 days per model family (the scorecard) and per task type (the change preview's monthly
// estimate). Numbers, codes and catalogue names only. The panel computes rates and differences for
// display and decides nothing.

export const USAGE_PATH = 'settings/admin/ai-models/usage';

export interface LatencyBucket {
  readonly bound: number;
  readonly above: boolean;
}

export interface FamilyUsage {
  readonly family: string;
  readonly provider: string;
  readonly calls: number;
  readonly failures: number;
  readonly stoodIn: number;
  readonly costMicroUsd: number;
  readonly p95: LatencyBucket | null;
  readonly evaluation: { readonly passed: number; readonly of: number };
}

export interface TaskUsage {
  readonly task: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costByFamily: readonly {
    readonly family: string;
    readonly costMicroUsd: number | null;
  }[];
}

export interface ModelUsage {
  readonly from: string;
  readonly to: string;
  readonly days: number;
  readonly families: readonly FamilyUsage[];
  readonly tasks: readonly TaskUsage[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const str = (value: unknown): value is string => typeof value === 'string';
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function listOf<T>(value: unknown, read: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value as unknown[]) {
    const row = read(item);
    if (row === null) return null;
    out.push(row);
  }
  return out;
}

function bucketOf(value: unknown): LatencyBucket | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !count(value['bound']) || typeof value['above'] !== 'boolean') {
    return undefined;
  }
  return { bound: value['bound'], above: value['above'] };
}

function familyOf(value: unknown): FamilyUsage | null {
  if (!isRecord(value)) return null;
  const { family, provider, calls, failures, stoodIn, costMicroUsd, evaluation } = value;
  const p95 = bucketOf(value['p95']);
  if (
    !str(family) ||
    !str(provider) ||
    !count(calls) ||
    !count(failures) ||
    !count(stoodIn) ||
    !count(costMicroUsd) ||
    p95 === undefined ||
    !isRecord(evaluation) ||
    !count(evaluation['passed']) ||
    !count(evaluation['of'])
  ) {
    return null;
  }
  return {
    family,
    provider,
    calls,
    failures,
    stoodIn,
    costMicroUsd,
    p95,
    evaluation: { passed: evaluation['passed'], of: evaluation['of'] },
  };
}

function familyCostOf(
  value: unknown,
): { readonly family: string; readonly costMicroUsd: number | null } | null {
  if (!isRecord(value) || !str(value['family'])) return null;
  const cost = value['costMicroUsd'];
  if (cost !== null && !count(cost)) return null;
  return { family: value['family'], costMicroUsd: cost };
}

function taskOf(value: unknown): TaskUsage | null {
  if (!isRecord(value)) return null;
  const { task, calls, inputTokens, outputTokens } = value;
  const costByFamily = listOf(value['costByFamily'], familyCostOf);
  if (
    !str(task) ||
    !count(calls) ||
    !count(inputTokens) ||
    !count(outputTokens) ||
    costByFamily === null
  ) {
    return null;
  }
  return { task, calls, inputTokens, outputTokens, costByFamily };
}

/** The answer, or null when it is not the expected shape (the page then says it failed). */
export function usageOf(value: unknown): ModelUsage | null {
  if (!isRecord(value)) return null;
  const { from, to, days } = value;
  const families = listOf(value['families'], familyOf);
  const tasks = listOf(value['tasks'], taskOf);
  if (!str(from) || !str(to) || !count(days) || families === null || tasks === null) return null;
  return { from, to, days, families, tasks };
}

/** Cost per 1,000 calls in micro-dollars, rounded; null without calls. */
export const costPerThousand = (item: FamilyUsage): number | null =>
  item.calls === 0 ? null : Math.round((item.costMicroUsd * 1000) / item.calls);

/** Failed calls in percent with one decimal ("2.5"); null without calls. */
export const errorPercent = (item: FamilyUsage): string | null =>
  item.calls === 0 ? null : ((item.failures * 100) / item.calls).toFixed(1);

/** Whole micro-dollars as US dollars with two decimals, rounded half up ("12.35"). */
export const roundDollars = (micro: number): string =>
  (Math.round(micro / 10_000) / 100).toFixed(2);

/**
 * What a task type would cost over the window with `family` first (null: no model, so nothing),
 * from the window's tokens at the family's price. Undefined when it cannot be estimated (no answer
 * for the task, or no usable route of the family).
 */
export function taskCostWith(
  usage: ModelUsage,
  task: string,
  family: string | null,
): number | undefined {
  const row = usage.tasks.find((item) => item.task === task);
  if (row === undefined) return undefined;
  if (family === null) return 0;
  const cost = row.costByFamily.find((item) => item.family === family)?.costMicroUsd;
  return cost === null || cost === undefined ? undefined : cost;
}

/** One task type's estimated monthly change when its first model changes. */
export type MonthlyChange =
  | { readonly kind: 'estimate'; readonly beforeMicroUsd: number; readonly afterMicroUsd: number }
  | { readonly kind: 'no-usage' }
  | { readonly kind: 'unknown' };

/**
 * The estimate for a task type whose first model goes from `before` to `after` (null: none). The
 * window's calls ran on the first model (or a fallback); the estimate prices the same tokens on the
 * new first model. A saver model or the threshold is not part of it.
 */
export function monthlyChangeOf(
  usage: ModelUsage,
  task: string,
  before: string | null,
  after: string | null,
): MonthlyChange {
  const row = usage.tasks.find((item) => item.task === task);
  if (row === undefined) return { kind: 'unknown' };
  if (row.calls === 0) return { kind: 'no-usage' };
  const beforeCost = taskCostWith(usage, task, before);
  const afterCost = taskCostWith(usage, task, after);
  if (beforeCost === undefined || afterCost === undefined) return { kind: 'unknown' };
  return { kind: 'estimate', beforeMicroUsd: beforeCost, afterMicroUsd: afterCost };
}
