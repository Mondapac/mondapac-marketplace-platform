import { LastChangedDto } from '../../../platform/audit/change-trail.dto';
import { ApiProperty } from '@nestjs/swagger';
import { FEEDBACK_REASONS, RATINGS } from '../domain/feedback';
import {
  AUDIENCES,
  BOUNDS,
  MODEL_TIERS,
  REPLY_LANGUAGES,
  RETENTIONS,
  SCOPES,
  SUPPORT_HANDOFFS,
  USER_GROUPS,
} from '../domain/assistant-settings';

// Bodies of the assistant settings routes.

export class AssistantSettingsFields {
  @ApiProperty({ description: 'The kill switch. Default false.' })
  enabled!: boolean;
  @ApiProperty({ enum: AUDIENCES, description: 'Who sees it. Default internal.' })
  audience!: string;
  @ApiProperty({
    nullable: true,
    type: Number,
    minimum: BOUNDS.audiencePercent.min,
    maximum: BOUNDS.audiencePercent.max,
    description: 'Required when audience is percent; null otherwise.',
  })
  audiencePercent!: number | null;
  @ApiProperty({
    enum: SCOPES,
    description:
      'Default read-only. cart-suggestions adds the cart card and cart-action cards (the buyer confirms each change).',
  })
  scope!: string;
  @ApiProperty({
    enum: MODEL_TIERS,
    description: 'Default fast. The model of each tier is server configuration.',
  })
  modelTier!: string;
  @ApiProperty({ enum: USER_GROUPS, description: 'Default guests-and-customers.' })
  users!: string;
  @ApiProperty({ ...BOUNDS.guestMessageLimit, description: 'Per 10 minutes. Default 20.' })
  guestMessageLimit!: number;
  @ApiProperty({ ...BOUNDS.customerMessageLimit, description: 'Per 10 minutes. Default 40.' })
  customerMessageLimit!: number;
  @ApiProperty({
    enum: RETENTIONS,
    description: 'Default 30-days; a guest is kept 30 days at most.',
  })
  retention!: string;
  @ApiProperty({ enum: REPLY_LANGUAGES, description: "Default buyer (the buyer's language)." })
  replyLanguage!: string;
  @ApiProperty({
    minimum: BOUNDS.dailySpendCapUsdCents.min,
    maximum: BOUNDS.dailySpendCapUsdCents.max,
    description: 'US cents. Default 1000. At most the monthly cap.',
  })
  dailySpendCapUsdCents!: number;
  @ApiProperty({
    minimum: BOUNDS.monthlySpendCapUsdCents.min,
    maximum: BOUNDS.monthlySpendCapUsdCents.max,
    description: 'US cents. Default 20000.',
  })
  monthlySpendCapUsdCents!: number;
  @ApiProperty({
    enum: SUPPORT_HANDOFFS,
    description: 'Default email-link; in-panel-form is not available yet.',
  })
  supportHandoff!: string;
  @ApiProperty({
    type: Boolean,
    description:
      'Basket proposals from a list: the assistant may plan a typed or pasted shopping list ' +
      'into a basket card the buyer reviews. Default false. Adds nothing to a cart by itself.',
  })
  basketProposals!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    maxLength: BOUNDS.welcomeTextLength,
    description: 'null or empty: the storefront default. No control characters, < or >.',
  })
  welcomeText!: string | null;
}

export class AssistantModelBody {
  @ApiProperty({ enum: MODEL_TIERS })
  tier!: string;
  @ApiProperty({ nullable: true, type: String, description: 'null: not configured.' })
  modelId!: string | null;
}

export class UnavailableOptionsBody {
  @ApiProperty({ enum: SCOPES, isArray: true })
  scope!: string[];
  @ApiProperty({ enum: SUPPORT_HANDOFFS, isArray: true })
  supportHandoff!: string[];
}

export class AutoOffBody {
  @ApiProperty({ description: 'When a cap switched the assistant off (ISO instant).' })
  at!: string;
  @ApiProperty({ enum: ['daily', 'monthly'] })
  cap!: string;
}

export class AssistantSpendBody {
  @ApiProperty({ description: 'Spend today, micro US dollars (the Market calendar).' })
  todayMicroUsd!: number;
  @ApiProperty({ description: 'Spend this month, micro US dollars.' })
  monthMicroUsd!: number;
  @ApiProperty({ description: 'Conversations started today.' })
  conversationsToday!: number;
  @ApiProperty({ type: AutoOffBody, nullable: true })
  lastAutoOff!: AutoOffBody | null;
}

export class AssistantSettingsBody {
  @ApiProperty({
    description: '0 while the built-in defaults are in force, then 1, 2, ... per change.',
  })
  version!: number;
  @ApiProperty({ type: AssistantSettingsFields })
  settings!: AssistantSettingsFields;
  @ApiProperty({ enum: ['set', 'not-set'], description: 'The key itself is never returned.' })
  apiKey!: string;
  @ApiProperty({ type: AssistantModelBody, isArray: true })
  models!: AssistantModelBody[];
  @ApiProperty({ type: AssistantSpendBody })
  spend!: AssistantSpendBody;
  @ApiProperty({ type: UnavailableOptionsBody })
  unavailableOptions!: UnavailableOptionsBody;
  @ApiProperty({
    type: LastChangedDto,
    nullable: true,
    description: 'Who changed the settings last and when; null while the defaults are in force.',
  })
  lastChanged!: LastChangedDto | null;
}

export class SetAssistantSettingsRequest {
  @ApiProperty({ description: 'The version the caller last read (0 for the defaults).' })
  expectedVersion!: number;
  @ApiProperty({
    type: AssistantSettingsFields,
    description: 'Every field, replacing the current ones.',
  })
  settings!: AssistantSettingsFields;
}

/** The request header that carries an internal preview token to the storefront routes. */
export const PREVIEW_HEADER = 'x-assistant-preview';

export class PreviewTokenBody {
  @ApiProperty({
    description:
      'Send it as the x-assistant-preview header with the storefront read and each message. ' +
      'Never store it beyond the browser tab; it names no account.',
  })
  token!: string;
  @ApiProperty({ description: 'ISO 8601 instant (UTC), 30 minutes after issue.' })
  expiresAt!: string;
}

export class StorefrontRetentionBody {
  @ApiProperty({ description: '0, 30 or 365.' }) customer!: number;
  @ApiProperty({ description: '0 or 30 (a guest is kept 30 days at most).' }) guest!: number;
}

export class StorefrontAssistantBody {
  @ApiProperty({ description: 'Switched on, configured, and this visitor is in the rollout.' })
  enabled!: boolean;
  @ApiProperty({ description: 'A guest may chat; false asks a guest to sign in.' })
  guestsAllowed!: boolean;
  @ApiProperty({ enum: REPLY_LANGUAGES })
  replyLanguage!: string;
  @ApiProperty({ nullable: true, type: String, description: 'null: the storefront default text.' })
  welcomeText!: string | null;
  @ApiProperty({
    type: StorefrontRetentionBody,
    nullable: true,
    description:
      'How many days a conversation is kept (0: not kept), for a signed-in customer and for a ' +
      'guest; null while the assistant is off for this visitor.',
  })
  retentionDays!: StorefrontRetentionBody | null;
  @ApiProperty({
    type: [String],
    description:
      "Fixed button texts in the buyer's language (lang, when the Market supports it; else the " +
      "Market's default); empty while the assistant is off for this visitor.",
  })
  quickPrompts!: string[];
  @ApiProperty({
    description: 'A valid internal preview token was sent: the widget marks itself a preview.',
  })
  preview!: boolean;
}

export class SendMessageRequest {
  @ApiProperty({ description: "The buyer's message: 1 to 1000 characters." })
  text!: string;
  @ApiProperty({
    required: false,
    type: String,
    description: "The widget's random visitor id (16 to 64 of A-Z a-z 0-9 _ -), for a rollout.",
  })
  visitor?: string;
}

export class FeedbackRequest {
  @ApiProperty({ enum: RATINGS })
  rating!: string;
  @ApiProperty({
    enum: FEEDBACK_REASONS,
    required: false,
    nullable: true,
    description: 'Only with rating down.',
  })
  reason?: string | null;
}

export class FeedbackBody {
  @ApiProperty({ enum: RATINGS })
  rating!: string;
  @ApiProperty({ enum: FEEDBACK_REASONS, nullable: true, type: String })
  reason!: string | null;
}

export class InsightsDayBody {
  @ApiProperty({ description: "A day of the Market's calendar, YYYY-MM-DD." })
  day!: string;
  @ApiProperty()
  conversations!: number;
  @ApiProperty({ description: 'Micro US dollars (1e-6 USD).' })
  spendMicroUsd!: number;
}

export class InsightsFeedbackBody {
  @ApiProperty()
  up!: number;
  @ApiProperty()
  down!: number;
  @ApiProperty({ nullable: true, type: Number, description: 'Up / (up + down), 0 to 1.' })
  upShare!: number | null;
  @ApiProperty({
    description:
      'Thumbs down by reason: wrong, not-found, other (a down without a reason is in none).',
    type: 'object',
    additionalProperties: { type: 'number' },
  })
  reasons!: Record<string, number>;
}

export class UnansweredRowBody {
  @ApiProperty({ description: 'The latest wording of the group, masked, 200 characters at most.' })
  query!: string;
  @ApiProperty()
  count!: number;
  @ApiProperty({ description: 'ISO 8601 instant.' })
  lastAt!: string;
  @ApiProperty({
    description: 'Turns of the group by reason: unavailable, tool-failed, no-results, thumbs-down.',
    type: 'object',
    additionalProperties: { type: 'number' },
  })
  reasons!: Record<string, number>;
}

export class UnansweredBody {
  @ApiProperty({ description: 'Groups, at most 200.' })
  total!: number;
  @ApiProperty()
  page!: number;
  @ApiProperty()
  pageSize!: number;
  @ApiProperty({ description: 'True when more flagged turns existed than were read.' })
  truncated!: boolean;
  @ApiProperty({ type: [UnansweredRowBody] })
  rows!: UnansweredRowBody[];
}

export class InsightsBody {
  @ApiProperty()
  from!: string;
  @ApiProperty()
  to!: string;
  @ApiProperty({ type: [InsightsDayBody] })
  days!: InsightsDayBody[];
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  totals!: { conversations: number; spendMicroUsd: number };
  @ApiProperty({ type: InsightsFeedbackBody })
  feedback!: InsightsFeedbackBody;
  @ApiProperty({ description: 'Assistant replies that showed the support card.' })
  handoffs!: number;
  @ApiProperty({ type: UnansweredBody })
  unanswered!: UnansweredBody;
}
