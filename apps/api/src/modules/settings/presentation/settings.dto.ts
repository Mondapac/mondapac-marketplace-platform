import type { SettingHistoryView } from '../application/use-cases/view-ai-gateway-history.use-case';
import type { AiModelsView } from '../application/use-cases/view-ai-models.use-case';
import type { EvaluationEstimate } from '../application/use-cases/estimate-ai-evaluation.use-case';
import type { PlaygroundAnswer } from '../application/use-cases/run-ai-playground.use-case';
import type { EvaluationRunDetail } from '../application/use-cases/view-ai-evaluation.use-case';
import type { EvaluationRunList } from '../application/use-cases/view-ai-evaluations.use-case';
import type { PlaygroundSuite } from '../application/use-cases/view-ai-playground-samples.use-case';

type EvaluationRunRecord = EvaluationRunList['runs'][number];
import type { OfferReviewEmergencyStopView } from '../application/use-cases/view-offer-review-emergency-stop.use-case';
import { ApiProperty } from '@nestjs/swagger';
import type { ListPaging } from '../domain/definitions';
import {
  CART_MODE_VALUES,
  LIST_PAGING_VALUES,
  SETTING_DEFINITIONS,
  targetOf,
} from '../domain/definitions';
import type {
  SettingChangeView,
  SettingView,
} from '../application/use-cases/view-list-paging-setting.use-case';

export class SettingsReviewBody {
  @ApiProperty({ description: 'A change is reviewed in this Market: the save asks for a note.' })
  reviewed!: boolean;
  @ApiProperty({ enum: ['low', 'medium', 'high'] }) risk!: string;
}

export class ReviewRequestRef {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Shown as SR-<number>.' }) number!: number;
}

export class SettingBody {
  @ApiProperty({ enum: SETTING_DEFINITIONS.map((definition) => definition.code) }) code!: string;
  @ApiProperty() value!: string;
  @ApiProperty({ description: '0 while the default is in force.' }) version!: number;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) updatedAt!: string | null;
  @ApiProperty({ type: SettingsReviewBody }) review!: SettingsReviewBody;
}

export class SettingChangeBody extends SettingBody {
  @ApiProperty({
    type: ReviewRequestRef,
    nullable: true,
    description: 'The review request the change opened; null where the area is not reviewed.',
  })
  request!: ReviewRequestRef | null;
}

export class SettingsListBody {
  @ApiProperty({ type: [SettingBody] }) settings!: SettingBody[];
}

export class AiModelOptionBody {
  @ApiProperty({ description: 'A model family of the route catalogue, e.g. claude-sonnet-5-5.' })
  family!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why it cannot be chosen for the task type in the Market now (unknown-model, ' +
      'task-unsupported, not-checked, region, no-key, retired, not-evaluated), or null.',
  })
  problem!: string | null;
}

export class AiModelsBody {
  @ApiProperty({ type: [SettingBody] }) settings!: SettingBody[];
  @ApiProperty({
    description:
      'Per task type (chat, extract, write, vision), every model family with why it cannot be ' +
      'chosen now.',
    type: 'object',
    additionalProperties: {
      type: 'array',
      items: { $ref: '#/components/schemas/AiModelOptionBody' },
    },
  })
  options!: Record<string, AiModelOptionBody[]>;
}

export class ChangeSettingRequest {
  @ApiProperty() code!: string;
  @ApiProperty() value!: string;
  @ApiProperty({ description: 'The version the admin saw; a stale edit is refused (409).' })
  expectedVersion!: number;
  @ApiProperty({
    required: false,
    description: 'The note for the reviewer, 1 to 500 characters; required where reviewed.',
  })
  note?: string;
}

export class ChangeCartModeRequest {
  @ApiProperty({ enum: [...CART_MODE_VALUES] }) value!: string;
  @ApiProperty({ description: 'The version the admin saw; a stale edit is refused (409).' })
  expectedVersion!: number;
  @ApiProperty({
    required: false,
    description: 'The note for the reviewer, 1 to 500 characters; required where reviewed.',
  })
  note?: string;
}

export class ChangeAiSettingRequest {
  @ApiProperty({ enum: ['ai-description-writer'] }) code!: string;
  @ApiProperty({ enum: ['off', 'on'] }) value!: string;
  @ApiProperty({ description: 'The version the admin saw; a stale edit is refused (409).' })
  expectedVersion!: number;
  @ApiProperty({
    required: false,
    description: 'The note for the reviewer, 1 to 500 characters; required where reviewed.',
  })
  note?: string;
}

export class TargetMoneyBody {
  @ApiProperty({ description: 'Minor units above zero, as a decimal string (at most 15 digits).' })
  amount!: string;
  @ApiProperty({ description: "ISO 4217; must be the Market's currency." }) currency!: string;
}

export class MonthlyRevenueTargetBody {
  @ApiProperty({
    type: TargetMoneyBody,
    nullable: true,
    description:
      "GMV with tax aimed for in each calendar month of the Market's zone; null while none is set.",
  })
  target!: TargetMoneyBody | null;
  @ApiProperty({ description: '0 while no target was ever set.' }) version!: number;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) updatedAt!: string | null;
  @ApiProperty({ type: SettingsReviewBody }) review!: SettingsReviewBody;
}

export class MonthlyRevenueTargetChangeBody extends MonthlyRevenueTargetBody {
  @ApiProperty({
    type: ReviewRequestRef,
    nullable: true,
    description: 'The review request the change opened; null where the area is not reviewed.',
  })
  request!: ReviewRequestRef | null;
}

export class ChangeMonthlyRevenueTargetRequest {
  @ApiProperty({ type: TargetMoneyBody, nullable: true, description: 'Null clears the target.' })
  target!: TargetMoneyBody | null;
  @ApiProperty({ description: 'The version the admin saw; a stale edit is refused (409).' })
  expectedVersion!: number;
  @ApiProperty({
    required: false,
    description: 'The note for the reviewer, 1 to 500 characters; required where reviewed.',
  })
  note?: string;
}

export class SettingChangeEntry {
  @ApiProperty({
    enum: [
      'offer-review-mode',
      'offer-review-probation-offers',
      'offer-review-reference-sellers',
      'offer-review-price-band',
      'offer-review-sampling',
      'offer-review-certificate-badges',
      'offer-review-backlog-count',
      'offer-review-backlog-hours',
    ],
  })
  code!: string;
  @ApiProperty({
    description:
      'A choice (mode: all, risk-based or off; badges: review or automatic) or a whole number ' +
      'as decimal text within the setting bounds (probation 0-100, reference sellers 2-20, ' +
      'price band 5-200, sampling 0-100, queue alert size 1-10000, queue alert hours 1-720).',
  })
  value!: string;
  @ApiProperty({ description: 'The version the admin saw; a stale edit is refused (409).' })
  expectedVersion!: number;
}

export class ChangeOfferReviewRequest {
  @ApiProperty({ type: [SettingChangeEntry], description: 'Each setting at most once.' })
  changes!: SettingChangeEntry[];
  @ApiProperty({
    required: false,
    description: 'The note for the reviewer, 1 to 500 characters; required where reviewed.',
  })
  note?: string;
}

export class ChangeEmergencyStopRequest {
  @ApiProperty({ enum: ['on', 'off'] }) value!: string;
  @ApiProperty({ description: 'The version the admin saw; 0 while the default is in force.' })
  expectedVersion!: number;
  @ApiProperty({ description: 'Why, 1 to 500 characters; always required.' })
  note!: string;
}

export class EmergencyStopBody {
  @ApiProperty() on!: boolean;
  @ApiProperty() version!: number;
  @ApiProperty({ type: String, nullable: true, description: 'ISO instant of the last switch.' })
  changedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Display name of who switched it.' })
  changedBy!: string | null;
}

export const emergencyStopBody = (view: OfferReviewEmergencyStopView): EmergencyStopBody => ({
  on: view.on,
  version: view.version,
  changedAt: view.changedAt === null ? null : view.changedAt.toString(),
  changedBy: view.changedBy,
});

export class SettingsChangeListBody {
  @ApiProperty({ type: [SettingChangeBody] }) settings!: SettingChangeBody[];
}

export const monthlyRevenueTargetBody = (view: SettingView): MonthlyRevenueTargetBody => {
  const target = targetOf(view.value);
  return {
    target:
      target === null ? null : { amount: target.amount.toString(), currency: target.currency },
    version: view.version,
    updatedAt: view.updatedAt === null ? null : view.updatedAt.toString(),
    review: { reviewed: view.review.reviewed, risk: view.review.risk },
  };
};

export const monthlyRevenueTargetChangeBody = (
  view: SettingChangeView,
): MonthlyRevenueTargetChangeBody => ({
  ...monthlyRevenueTargetBody(view),
  request: view.request === null ? null : { id: view.request.id, number: view.request.number },
});

export class ListPagingBody {
  @ApiProperty({ enum: [...LIST_PAGING_VALUES] }) listPaging!: string;
}

export const settingBody = (view: SettingView): SettingBody => ({
  code: view.code,
  value: view.value,
  version: view.version,
  updatedAt: view.updatedAt === null ? null : view.updatedAt.toString(),
  review: { reviewed: view.review.reviewed, risk: view.review.risk },
});

export const settingChangeBody = (view: SettingChangeView): SettingChangeBody => ({
  ...settingBody(view),
  request: view.request === null ? null : { id: view.request.id, number: view.request.number },
});

export const settingsChangeListBody = (
  views: readonly SettingChangeView[],
): SettingsChangeListBody => ({ settings: views.map(settingChangeBody) });

export const settingsListBody = (views: readonly SettingView[]): SettingsListBody => ({
  settings: views.map(settingBody),
});

export const aiModelsBody = (view: AiModelsView): AiModelsBody => ({
  settings: view.settings.map(settingBody),
  options: Object.fromEntries(
    Object.entries(view.options).map(([task, options]) => [
      task,
      options.map(({ family, problem }) => ({ family, problem })),
    ]),
  ),
});

export const listPagingBody = (value: ListPaging): ListPagingBody => ({ listPaging: value });

// AI Gateway G4c: evaluation runs and the playground. Codes, numbers and ids; the playground's
// `text` is the capability's guarded plain text (never HTML), and no run stores any model text.

const RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'closed-budget',
  'closed-saver',
  'closed-off',
  'cancelled',
];
const VERDICTS = ['pending', 'pass-candidate', 'failed', 'incomplete', 'superseded'];
const SAMPLE_OUTCOMES = ['ok', 'timeout', 'unavailable', 'rate-limited', 'rejected', 'refused'];
const CHECKS = ['leak', 'empty', 'incomplete', 'too-long', 'missing-fact'];

export class AiEvaluationRunBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'The route catalogue provider, e.g. anthropic.' }) provider!: string;
  @ApiProperty({ description: 'The route catalogue model family.' }) family!: string;
  @ApiProperty({ enum: RUN_STATUSES }) status!: string;
  @ApiProperty({ format: 'uuid', description: 'The admin who asked for it.' })
  requestedBy!: string;
  @ApiProperty({ format: 'date-time' }) requestedAt!: string;
  @ApiProperty({ description: 'The estimate confirmed, US micro-dollars.' })
  estimateMicroUsd!: number;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) startedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) endedAt!: string | null;
}

export class AiEvaluationRunListBody {
  @ApiProperty({ type: [AiEvaluationRunBody] }) runs!: AiEvaluationRunBody[];
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The cursor of the next page (pass it as ?cursor=), or null on the last one.',
  })
  next!: string | null;
}

export class AiEvaluationCapabilityBody {
  @ApiProperty() capability!: string;
  @ApiProperty() promptVersion!: string;
  @ApiProperty() setVersion!: string;
  @ApiProperty() samplesTotal!: number;
  @ApiProperty({
    enum: VERDICTS,
    description: 'pass-candidate is never a pass: a PR records a pass in the results file.',
  })
  verdict!: string;
}

export class AiEvaluationSampleBody {
  @ApiProperty() capability!: string;
  @ApiProperty() sampleId!: string;
  @ApiProperty({ enum: SAMPLE_OUTCOMES }) outcome!: string;
  @ApiProperty({ enum: CHECKS, isArray: true, description: 'Failed checks; empty when passed.' })
  checks!: string[];
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) callId!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'The route kind that answered.' })
  route!: string | null;
  @ApiProperty({ nullable: true, type: Number }) attempt!: number | null;
  @ApiProperty() inputTokens!: number;
  @ApiProperty() outputTokens!: number;
  @ApiProperty({ description: 'US micro-dollars.' }) costMicroUsd!: number;
  @ApiProperty({ nullable: true, type: Number }) latencyMs!: number | null;
  @ApiProperty({ format: 'date-time' }) finishedAt!: string;
}

export class AiEvaluationRunDetailBody {
  @ApiProperty({ type: AiEvaluationRunBody }) run!: AiEvaluationRunBody;
  @ApiProperty({ type: [AiEvaluationCapabilityBody] })
  capabilities!: AiEvaluationCapabilityBody[];
  @ApiProperty({ type: [AiEvaluationSampleBody] }) samples!: AiEvaluationSampleBody[];
  @ApiProperty({ description: 'What the samples cost so far, US micro-dollars.' })
  costMicroUsd!: number;
}

export class AiEvaluationCapabilityEstimateBody {
  @ApiProperty() capability!: string;
  @ApiProperty() promptVersion!: string;
  @ApiProperty() setVersion!: string;
  @ApiProperty() samples!: number;
  @ApiProperty({ description: "The sum of each sample's reservation, US micro-dollars." })
  estimateMicroUsd!: number;
}

export class AiEvaluationEstimateBody {
  @ApiProperty() provider!: string;
  @ApiProperty() family!: string;
  @ApiProperty({ type: [AiEvaluationCapabilityEstimateBody] })
  capabilities!: AiEvaluationCapabilityEstimateBody[];
  @ApiProperty({ description: 'The whole estimate; send it back as expectedEstimateMicroUsd.' })
  estimateMicroUsd!: number;
  @ApiProperty({ description: 'What is left of the evaluation budget this Market month.' })
  budgetLeftMicroUsd!: number;
  @ApiProperty({
    isArray: true,
    type: String,
    description:
      'What blocks a run now: unknown-model, task-unsupported, not-checked, region, no-key, ' +
      'retired, no-suite, run-open or saver-closed; empty when it may start.',
  })
  blockers!: string[];
}

export class RunAiEvaluationRequest {
  @ApiProperty() provider!: string;
  @ApiProperty() family!: string;
  @ApiProperty({ description: 'The estimate the admin confirmed; a stale one is refused.' })
  expectedEstimateMicroUsd!: number;
}

export class AiEvaluationQueuedBody {
  @ApiProperty({ format: 'uuid' }) runId!: string;
  @ApiProperty({ type: AiEvaluationEstimateBody }) estimate!: AiEvaluationEstimateBody;
}

export class AiEvaluationCancelledBody {
  @ApiProperty({ format: 'uuid' }) runId!: string;
}

export class AiPlaygroundSampleBody {
  @ApiProperty() id!: string;
  @ApiProperty({ description: "A plain-text summary of the sample's synthetic input." })
  label!: string;
}

export class AiPlaygroundSuiteBody {
  @ApiProperty() capability!: string;
  @ApiProperty() setVersion!: string;
  @ApiProperty({ type: [AiPlaygroundSampleBody] }) samples!: AiPlaygroundSampleBody[];
}

export class AiPlaygroundSamplesBody {
  @ApiProperty({ type: [AiPlaygroundSuiteBody] }) suites!: AiPlaygroundSuiteBody[];
}

export class RunAiPlaygroundRequest {
  @ApiProperty() capability!: string;
  @ApiProperty() sampleId!: string;
  @ApiProperty({ type: [String], minItems: 2, maxItems: 2, description: 'Two distinct families.' })
  families!: string[];
}

export class AiPlaygroundAnswerBody {
  @ApiProperty() family!: string;
  @ApiProperty({
    enum: [...SAMPLE_OUTCOMES, 'closed-budget', 'closed-saver', 'closed-off'],
  })
  outcome!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'What the capability would show, after its own guard: plain text, never HTML.',
  })
  text!: string | null;
  @ApiProperty({ enum: CHECKS, isArray: true }) checks!: string[];
  @ApiProperty({ description: 'US micro-dollars, from the evaluation budget.' })
  costMicroUsd!: number;
  @ApiProperty({ nullable: true, type: Number }) latencyMs!: number | null;
  @ApiProperty({ nullable: true, type: String }) route!: string | null;
}

export class AiPlaygroundBody {
  @ApiProperty({ type: [AiPlaygroundAnswerBody] }) answers!: AiPlaygroundAnswerBody[];
}

const instantText = (at: { toString(): string } | null): string | null =>
  at === null ? null : at.toString();

export const aiEvaluationRunBody = (run: EvaluationRunRecord): AiEvaluationRunBody => ({
  id: run.id,
  provider: run.provider,
  family: run.family,
  status: run.status,
  requestedBy: run.requestedBy,
  requestedAt: run.requestedAt.toString(),
  estimateMicroUsd: run.estimateMicroUsd,
  startedAt: instantText(run.startedAt),
  endedAt: instantText(run.endedAt),
});

export const aiEvaluationRunListBody = (list: EvaluationRunList): AiEvaluationRunListBody => ({
  runs: list.runs.map(aiEvaluationRunBody),
  next: list.next,
});

export const aiEvaluationRunDetailBody = (
  detail: EvaluationRunDetail,
): AiEvaluationRunDetailBody => ({
  run: aiEvaluationRunBody(detail.run),
  capabilities: detail.capabilities.map((row) => ({
    capability: row.capability,
    promptVersion: row.promptVersion,
    setVersion: row.setVersion,
    samplesTotal: row.samplesTotal,
    verdict: row.verdict,
  })),
  samples: detail.samples.map((sample) => ({
    capability: sample.capability,
    sampleId: sample.sampleId,
    outcome: sample.outcome,
    checks: [...sample.checks],
    callId: sample.callId,
    route: sample.route,
    attempt: sample.attempt,
    inputTokens: sample.inputTokens,
    outputTokens: sample.outputTokens,
    costMicroUsd: sample.costMicroUsd,
    latencyMs: sample.latencyMs,
    finishedAt: sample.finishedAt.toString(),
  })),
  costMicroUsd: detail.costMicroUsd,
});

export const aiEvaluationEstimateBody = (
  estimate: EvaluationEstimate,
): AiEvaluationEstimateBody => ({
  provider: estimate.provider,
  family: estimate.family,
  capabilities: estimate.capabilities.map((item) => ({
    capability: item.capability,
    promptVersion: item.promptVersion,
    setVersion: item.setVersion,
    samples: item.samples,
    estimateMicroUsd: item.estimateMicroUsd,
  })),
  estimateMicroUsd: estimate.estimateMicroUsd,
  budgetLeftMicroUsd: estimate.budgetLeftMicroUsd,
  blockers: [...estimate.blockers],
});

export const aiPlaygroundSamplesBody = (
  suites: readonly PlaygroundSuite[],
): AiPlaygroundSamplesBody => ({
  suites: suites.map((suite) => ({
    capability: suite.capability,
    setVersion: suite.setVersion,
    samples: suite.samples.map(({ id, label }) => ({ id, label })),
  })),
});

export const aiPlaygroundBody = (answers: readonly PlaygroundAnswer[]): AiPlaygroundBody => ({
  answers: answers.map((answer) => ({
    family: answer.family,
    outcome: answer.outcome,
    text: answer.text,
    checks: [...answer.checks],
    costMicroUsd: answer.costMicroUsd,
    latencyMs: answer.latencyMs,
    route: answer.route,
  })),
});

// AI Gateway G4d3: the history of one AI setting and a panel revert.

export class SettingHistoryEntryBody {
  @ApiProperty({ enum: SETTING_DEFINITIONS.map((definition) => definition.code) }) code!: string;
  @ApiProperty({ description: 'The version this change made (1 for the first change).' })
  version!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The value before the change; null while the default was in force.',
  })
  previousValue!: string | null;
  @ApiProperty() value!: string;
  @ApiProperty({ format: 'date-time' }) changedAt!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The display name of the admin who made the change; null when unknown.',
  })
  changedBy!: string | null;
  @ApiProperty({ type: String, nullable: true, description: "The admin's reason, if any." })
  note!: string | null;
  @ApiProperty({ description: 'Whether this version is the one in force.' }) current!: boolean;
}

export class SettingHistoryBody {
  @ApiProperty({ type: [SettingHistoryEntryBody], description: 'Newest first, at most 50.' })
  history!: SettingHistoryEntryBody[];
}

export class RevertSettingRequest {
  @ApiProperty({ description: 'The setting to revert, a code of the page.' }) code!: string;
  @ApiProperty({
    description: 'The version whose value comes back; 0 is the default (before any change).',
  })
  version!: number;
  @ApiProperty({ description: 'The version in force the admin saw; a stale one is refused (409).' })
  expectedVersion!: number;
  @ApiProperty({
    required: false,
    description:
      'The reason, 1 to 500 characters: always required for ai-gateway-emergency-stop, else ' +
      'required where reviewed.',
  })
  note?: string;
}

export const settingHistoryBody = (views: readonly SettingHistoryView[]): SettingHistoryBody => ({
  history: views.map((view) => ({
    code: view.code,
    version: view.version,
    previousValue: view.previousValue,
    value: view.value,
    changedAt: view.changedAt.toString(),
    changedBy: view.changedBy,
    note: view.note,
    current: view.current,
  })),
});
