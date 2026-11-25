import type { AiModelsView } from '../application/use-cases/view-ai-models.use-case';
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
  @ApiProperty({ enum: ['ai-description-writer', 'ai-description-writer-tier'] }) code!: string;
  @ApiProperty({ enum: ['off', 'on', 'fast', 'balanced'] }) value!: string;
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
    ],
  })
  code!: string;
  @ApiProperty({
    description:
      'A choice (mode: all, risk-based or off; badges: review or automatic) or a whole number ' +
      'as decimal text within the setting bounds (probation 0-100, reference sellers 2-20, ' +
      'price band 5-200, sampling 0-100).',
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
