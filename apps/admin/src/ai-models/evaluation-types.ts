// Answers of the AI evaluation routes (apps/api settings module, AI Gateway G4c). The panel shows
// what the API answers and decides nothing: a verdict of `pass-candidate` is never a pass (a PR
// records a pass), and no model text is stored, so none is shown.

import { microToDollars } from '../ai-gateway/types.ts';

export const EVALUATIONS_PATH = 'settings/admin/ai-models/evaluations';
export const EVALUATION_ESTIMATE_PATH = `${EVALUATIONS_PATH}/estimate`;
export const evaluationPath = (runId: string): string => `${EVALUATIONS_PATH}/${runId}`;
export const evaluationCancelPath = (runId: string): string => `${evaluationPath(runId)}/cancel`;

/** The one provider of the route catalogue today (ADR-0052); the API checks it again. */
export const EVALUATION_PROVIDER = 'anthropic';

export const OPEN_STATUSES: readonly string[] = ['queued', 'running'];

export interface EvaluationRun {
  readonly id: string;
  readonly provider: string;
  readonly family: string;
  readonly status: string;
  readonly requestedAt: string;
  readonly estimateMicroUsd: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

export interface EvaluationRunList {
  readonly runs: readonly EvaluationRun[];
  readonly next: string | null;
}

export interface CapabilityVerdict {
  readonly capability: string;
  readonly promptVersion: string;
  readonly setVersion: string;
  readonly samplesTotal: number;
  readonly verdict: string;
}

export interface EvaluationSample {
  readonly capability: string;
  readonly sampleId: string;
  readonly outcome: string;
  readonly checks: readonly string[];
  readonly route: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicroUsd: number;
  readonly latencyMs: number | null;
}

export interface EvaluationDetail {
  readonly run: EvaluationRun;
  readonly capabilities: readonly CapabilityVerdict[];
  readonly samples: readonly EvaluationSample[];
  readonly costMicroUsd: number;
}

export interface CapabilityEstimate {
  readonly capability: string;
  readonly promptVersion: string;
  readonly setVersion: string;
  readonly samples: number;
  readonly estimateMicroUsd: number;
}

export interface EvaluationEstimate {
  readonly provider: string;
  readonly family: string;
  readonly capabilities: readonly CapabilityEstimate[];
  readonly estimateMicroUsd: number;
  readonly budgetLeftMicroUsd: number;
  readonly blockers: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const str = (value: unknown): value is string => typeof value === 'string';
const num = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const strOrNull = (value: unknown): value is string | null => value === null || str(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(str);

function runOf(value: unknown): EvaluationRun | null {
  if (!isRecord(value)) return null;
  const { id, provider, family, status, requestedAt, estimateMicroUsd, startedAt, endedAt } = value;
  if (
    !str(id) ||
    !str(provider) ||
    !str(family) ||
    !str(status) ||
    !str(requestedAt) ||
    !num(estimateMicroUsd) ||
    !strOrNull(startedAt) ||
    !strOrNull(endedAt)
  ) {
    return null;
  }
  return { id, provider, family, status, requestedAt, estimateMicroUsd, startedAt, endedAt };
}

/** Reads each item with `read`; null when the value is not a list or one item is malformed. */
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

export function runListOf(value: unknown): EvaluationRunList | null {
  if (!isRecord(value) || !strOrNull(value['next'])) return null;
  const runs = listOf(value['runs'], runOf);
  return runs === null ? null : { runs, next: value['next'] };
}

function verdictOf(value: unknown): CapabilityVerdict | null {
  if (!isRecord(value)) return null;
  const { capability, promptVersion, setVersion, samplesTotal, verdict } = value;
  if (
    !str(capability) ||
    !str(promptVersion) ||
    !str(setVersion) ||
    !num(samplesTotal) ||
    !str(verdict)
  ) {
    return null;
  }
  return { capability, promptVersion, setVersion, samplesTotal, verdict };
}

function sampleOf(value: unknown): EvaluationSample | null {
  if (!isRecord(value)) return null;
  const { capability, sampleId, outcome, checks, route, inputTokens, outputTokens } = value;
  const { costMicroUsd, latencyMs } = value;
  if (
    !str(capability) ||
    !str(sampleId) ||
    !str(outcome) ||
    !strings(checks) ||
    !strOrNull(route) ||
    !num(inputTokens) ||
    !num(outputTokens) ||
    !num(costMicroUsd) ||
    !(latencyMs === null || num(latencyMs))
  ) {
    return null;
  }
  return {
    capability,
    sampleId,
    outcome,
    checks,
    route,
    inputTokens,
    outputTokens,
    costMicroUsd,
    latencyMs,
  };
}

export function detailOf(value: unknown): EvaluationDetail | null {
  if (!isRecord(value) || !num(value['costMicroUsd'])) return null;
  const run = runOf(value['run']);
  const capabilities = listOf(value['capabilities'], verdictOf);
  const samples = listOf(value['samples'], sampleOf);
  if (run === null || capabilities === null || samples === null) return null;
  return { run, capabilities, samples, costMicroUsd: value['costMicroUsd'] };
}

function capabilityEstimateOf(value: unknown): CapabilityEstimate | null {
  if (!isRecord(value)) return null;
  const { capability, promptVersion, setVersion, samples, estimateMicroUsd } = value;
  if (
    !str(capability) ||
    !str(promptVersion) ||
    !str(setVersion) ||
    !num(samples) ||
    !num(estimateMicroUsd)
  ) {
    return null;
  }
  return { capability, promptVersion, setVersion, samples, estimateMicroUsd };
}

export function estimateOf(value: unknown): EvaluationEstimate | null {
  if (!isRecord(value)) return null;
  const { provider, family, estimateMicroUsd, budgetLeftMicroUsd, blockers } = value;
  const capabilities = listOf(value['capabilities'], capabilityEstimateOf);
  if (
    !str(provider) ||
    !str(family) ||
    !num(estimateMicroUsd) ||
    !num(budgetLeftMicroUsd) ||
    !strings(blockers) ||
    capabilities === null
  ) {
    return null;
  }
  return { provider, family, capabilities, estimateMicroUsd, budgetLeftMicroUsd, blockers };
}

/** US dollars text of whole micro-dollars ("0.5"); shown with a dollar sign by the caller. */
export const dollars = (micro: number): string =>
  Number.isSafeInteger(micro) && micro >= 0 ? microToDollars(String(micro)) : String(micro);

/** The model families the page may evaluate: every family it lists for any task type, once. */
export function familiesOfOptions(
  options: Readonly<Record<string, readonly { readonly family: string }[]>>,
): readonly string[] {
  return [
    ...new Set(Object.values(options).flatMap((list) => list.map((item) => item.family))),
  ].sort();
}
