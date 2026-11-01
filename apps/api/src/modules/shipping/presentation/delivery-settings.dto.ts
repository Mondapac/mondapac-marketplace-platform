import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LastChangedDto } from '../../../platform/audit/change-trail.dto';
import { lastChangedBody } from '../../../platform/audit/change-trail';
import { ROUNDING_STEPS } from '../domain/delivery-margin';
import {
  formatCutoff,
  MAX_SCHEDULED_DAYS_AHEAD,
  MAX_WINDOW_MINUTES,
  MIN_SCHEDULED_DAYS_AHEAD,
  MIN_WINDOW_MINUTES,
  WINDOW_STEP_MINUTES,
} from '../domain/delivery-settings';
import type { DeliverySettingsPage } from '../application/use-cases/view-delivery-settings.use-case';
import type { SellerDeliveryMethodsView } from '../application/use-cases/view-seller-delivery-methods.use-case';

// Bodies of the delivery-settings routes (delivery models, package 4). Whole numbers, flags and
// codes only; a time is `HH:MM`, local time in the zone of the seller (the Market zone is the fallback).

const METHODS = ['pickup', 'instant', 'same_day', 'scheduled'];

export class EnabledMethodsBody {
  @ApiProperty() pickup!: boolean;
  @ApiProperty() instant!: boolean;
  @ApiProperty() same_day!: boolean;
  @ApiProperty() scheduled!: boolean;
}

export class MarginBody {
  @ApiProperty({ enum: ['none', 'percent', 'fixed'] }) kind!: string;
  @ApiPropertyOptional({
    minimum: 0,
    maximum: 10000,
    description: 'percent only: hundredths of a percent (1000 is 10 %).',
  })
  basisPoints?: number;
  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1000000,
    description: 'fixed only: minor units of the Market currency.',
  })
  amountMinor?: number;
}

export class DeliverySettingsRequest {
  @ApiProperty({ type: EnabledMethodsBody }) enabled!: EnabledMethodsBody;
  @ApiProperty({ example: '12:00', description: 'Same-day cut-off, HH:MM local time.' })
  sameDayCutoff!: string;
  @ApiProperty({ minimum: MIN_SCHEDULED_DAYS_AHEAD, maximum: MAX_SCHEDULED_DAYS_AHEAD })
  scheduledDaysAhead!: number;
  @ApiProperty({
    minimum: MIN_WINDOW_MINUTES,
    maximum: MAX_WINDOW_MINUTES,
    multipleOf: WINDOW_STEP_MINUTES,
  })
  scheduledWindowMinutes!: number;
  @ApiProperty({ type: MarginBody }) margin!: MarginBody;
  @ApiProperty({
    enum: [...ROUNDING_STEPS],
    description: 'Round the total up to a multiple of this many minor units; 1 is no rounding.',
  })
  roundingStepMinor!: number;
  @ApiProperty({ minimum: 0, description: 'The version read; 0 before the first save.' })
  expectedVersion!: number;
}

export class DeliverySettingsBody {
  @ApiProperty({ type: EnabledMethodsBody }) enabled!: EnabledMethodsBody;
  @ApiProperty({ example: '12:00' }) sameDayCutoff!: string;
  @ApiProperty() scheduledDaysAhead!: number;
  @ApiProperty() scheduledWindowMinutes!: number;
  @ApiProperty({ type: MarginBody }) margin!: MarginBody;
  @ApiProperty({ enum: [...ROUNDING_STEPS] }) roundingStepMinor!: number;
  @ApiProperty({ description: 'Rises with each save; 0 while the defaults apply.' })
  version!: number;
  @ApiProperty({ description: 'The Market currency of a fixed margin and the rounding steps.' })
  currency!: string;
  @ApiProperty({ description: 'The Market IANA zone: the fallback for a seller without one.' })
  marketZone!: string;
  @ApiProperty({ enum: [...ROUNDING_STEPS], isArray: true }) roundingSteps!: number[];
  @ApiProperty({
    type: LastChangedDto,
    nullable: true,
    description: 'Who changed this page last and when; null while nothing was ever changed.',
  })
  lastChanged!: LastChangedDto | null;
}

export function settingsBody(view: DeliverySettingsPage) {
  const { settings } = view;
  const { margin } = settings;
  return {
    enabled: { ...settings.enabled },
    sameDayCutoff: formatCutoff(settings.sameDayCutoffMinutes),
    scheduledDaysAhead: settings.scheduledDaysAhead,
    scheduledWindowMinutes: settings.scheduledWindowMinutes,
    margin:
      margin.kind === 'percent'
        ? { kind: margin.kind, basisPoints: margin.basisPoints }
        : margin.kind === 'fixed'
          ? { kind: margin.kind, amountMinor: margin.amountMinor }
          : { kind: margin.kind },
    roundingStepMinor: settings.roundingStepMinor,
    version: settings.version,
    currency: view.currency,
    marketZone: view.marketZone,
    roundingSteps: [...ROUNDING_STEPS],
    lastChanged: lastChangedBody(view.lastChanged),
  };
}

export class SellerDeliveryMethodsRequest {
  @ApiProperty({ enum: METHODS, isArray: true, description: 'The methods the seller supports.' })
  supported!: string[];
}

export class SellerDeliveryMethodsBody {
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ enum: METHODS, isArray: true }) supported!: string[];
  @ApiProperty({
    type: EnabledMethodsBody,
    description: 'What the Market has on; a method that is off is unavailable whatever this says.',
  })
  platformEnabled!: EnabledMethodsBody;
}

export const sellerMethodsBody = (view: SellerDeliveryMethodsView) => ({
  sellerId: view.sellerId,
  supported: [...view.supported],
  platformEnabled: { ...view.platformEnabled },
});
