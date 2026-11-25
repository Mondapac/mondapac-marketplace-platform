import { ApiProperty } from '@nestjs/swagger';
import type { MonthForecast } from '../domain/month-forecast';

// The month-end forecast as JSON (dashboards v2, phase 2): money as decimal strings of minor
// units. The forecast is always an estimate (the run rate to date carried to the month's end);
// the panel labels it so. The admin dashboard builds the same shape in its own DTO.

export class MonthEndForecastBody {
  @ApiProperty({
    enum: ['estimate', 'not-enough-data'],
    description:
      '`estimate`: month to date ÷ time elapsed × length of the month, an estimate, never a ' +
      'promise. `not-enough-data`: fewer than `minimumDays` whole days of the month behind today.',
  })
  status!: string;
  @ApiProperty({ required: false, type: String, description: 'Only with `estimate`.' })
  amount?: string;
  @ApiProperty({ required: false, type: Number, description: 'Only with `not-enough-data`.' })
  daysElapsed?: number;
  @ApiProperty({ required: false, type: Number, description: 'Only with `not-enough-data`.' })
  minimumDays?: number;
}

export class MonthFiguresBody {
  @ApiProperty({ example: '2026-11', description: "The calendar month of the Market's zone." })
  month!: string;
  @ApiProperty({ example: '2026-10' }) lastMonth!: string;
  @ApiProperty({ description: 'The IANA zone the month is counted in.' }) timezone!: string;
  @ApiProperty({ description: 'ISO 4217; every amount is in it.' }) currency!: string;
  @ApiProperty() daysInMonth!: number;
  @ApiProperty({ description: '1 on the first of the month.' }) dayOfMonth!: number;
  @ApiProperty({ description: 'Days still to sell in, today included.' }) daysLeft!: number;
  @ApiProperty({ description: 'Revenue with tax of the 1st through now, minor units.' })
  monthToDate!: string;
  @ApiProperty({ description: 'Revenue with tax of the whole month before (the comparison).' })
  lastMonthTotal!: string;
  @ApiProperty({ type: MonthEndForecastBody }) forecast!: MonthEndForecastBody;
  @ApiProperty({ nullable: true, type: String, description: 'Null while none is set.' })
  target!: string | null;
  @ApiProperty({ nullable: true, type: Number, description: 'Month to date ÷ target, bp.' })
  progressBp!: number | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Forecast ÷ target, bp ("on pace for"); null without a target or a forecast.',
  })
  paceBp!: number | null;
  @ApiProperty({ nullable: true, type: String, description: 'Left to reach the target, ≥ 0.' })
  toGo!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'toGo ÷ daysLeft, half up.' })
  perDayToGo!: string | null;
}

const text = (value: bigint | null): string | null => (value === null ? null : value.toString());

export function monthFiguresBody(
  figures: MonthForecast,
  timezone: string,
  currency: string,
): MonthFiguresBody {
  const { forecast } = figures;
  return {
    month: figures.month,
    lastMonth: figures.lastMonth,
    timezone,
    currency,
    daysInMonth: figures.daysInMonth,
    dayOfMonth: figures.dayOfMonth,
    daysLeft: figures.daysLeft,
    monthToDate: figures.monthToDate.toString(),
    lastMonthTotal: figures.lastMonthTotal.toString(),
    forecast:
      forecast.status === 'estimate'
        ? { status: forecast.status, amount: forecast.amount.toString() }
        : {
            status: forecast.status,
            daysElapsed: forecast.daysElapsed,
            minimumDays: forecast.minimumDays,
          },
    target: text(figures.target),
    progressBp: figures.progressBp,
    paceBp: figures.paceBp,
    toGo: text(figures.toGo),
    perDayToGo: text(figures.perDayToGo),
  };
}
