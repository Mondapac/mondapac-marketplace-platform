import { ApiProperty } from '@nestjs/swagger';
import type { ListPaging } from '../domain/definitions';
import { CART_MODE_VALUES, LIST_PAGING_VALUES, SETTING_DEFINITIONS } from '../domain/definitions';
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

export class SettingsChangeListBody {
  @ApiProperty({ type: [SettingChangeBody] }) settings!: SettingChangeBody[];
}

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

export const listPagingBody = (value: ListPaging): ListPagingBody => ({ listPaging: value });
