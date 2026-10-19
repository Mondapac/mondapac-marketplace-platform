import { ApiProperty } from '@nestjs/swagger';
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
    description: 'Default read-only; cart-suggestions is not available yet.',
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
  @ApiProperty({ type: UnavailableOptionsBody })
  unavailableOptions!: UnavailableOptionsBody;
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

export class StorefrontAssistantBody {
  @ApiProperty({ description: 'Switched on, configured, and this visitor is in the rollout.' })
  enabled!: boolean;
  @ApiProperty({ description: 'A guest may chat; false asks a guest to sign in.' })
  guestsAllowed!: boolean;
  @ApiProperty({ enum: REPLY_LANGUAGES })
  replyLanguage!: string;
  @ApiProperty({ nullable: true, type: String, description: 'null: the storefront default text.' })
  welcomeText!: string | null;
}
