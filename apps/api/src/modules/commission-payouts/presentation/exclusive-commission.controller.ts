import { Controller, Get, Logger, Res } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext, Money } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import {
  ViewOwnExclusiveCommission,
  type ExclusiveCommissionView,
} from '../application/use-cases/view-own-exclusive-commission.use-case';
import { refusal } from './http-answers';

const ERROR = { type: Object };

class SavedAmountBody {
  @ApiProperty({
    description:
      'Minor units. Negative when the month’s refunds gave back more than the month saved.',
  })
  amount!: string;
  @ApiProperty({ description: 'ISO 4217.' }) currency!: string;
}

class ExclusiveRuleBody {
  @ApiProperty({ description: "The seller's rate in force now, basis points." })
  standardRateBps!: number;
  @ApiProperty({ description: "The rate on its exclusive customers' lines now, basis points." })
  exclusiveRateBps!: number;
  @ApiProperty({ description: 'Months after a customer joined that the lower rate applies.' })
  months!: number;
}

class SavingsMonthBody {
  @ApiProperty({ description: '`YYYY-MM` in `zone`.' }) month!: string;
  @ApiProperty({ type: [SavedAmountBody], description: 'Per currency; empty: nothing saved.' })
  saved!: SavedAmountBody[];
}

export class ExclusiveCommissionBody {
  @ApiProperty({
    type: ExclusiveRuleBody,
    nullable: true,
    description: 'Null when the Market has no lower commission for exclusive customers.',
  })
  rule!: ExclusiveRuleBody | null;
  @ApiProperty({ description: 'The IANA zone the months are cut in (the Market’s).' })
  zone!: string;
  @ApiProperty({ type: [SavingsMonthBody], description: 'The last 12 months, oldest first.' })
  months!: SavingsMonthBody[];
  @ApiProperty({ type: [SavedAmountBody], description: 'This month’s savings (the last month).' })
  thisMonth!: SavedAmountBody[];
}

const amounts = (saved: readonly Money[]): SavedAmountBody[] =>
  saved.map((row) => ({ amount: row.amount.toString(), currency: row.currency }));

export const exclusiveCommissionBody = (
  view: ExclusiveCommissionView,
): ExclusiveCommissionBody => ({
  rule: view.rule === null ? null : { ...view.rule },
  zone: view.zone,
  months: view.months.map((month) => ({ month: month.month, saved: amounts(month.saved) })),
  thisMonth: amounts(view.months.at(-1)?.saved ?? []),
});

/**
 * The signed-in seller's lower commission on its exclusive customers and its savings by month
 * (customers management phase 4b; the seller's Exclusive perks page). `no-store`.
 */
@ApiTags('commission-payouts')
@RoutePopulation('seller')
@ReadsSession()
@Controller('commission-payouts/seller/exclusive-commission')
export class SellerExclusiveCommissionController {
  readonly #logger = new Logger('SellerExclusiveCommissionController');

  constructor(private readonly view: ViewOwnExclusiveCommission) {}

  @Get()
  @ApiOperation({
    summary: "The seller's commission on its exclusive customers and what it saved",
    description:
      'Needs commission-payouts.earnings.view. `rule`: the seller’s rate in force now, the lower ' +
      'rate its exclusive customers’ lines carry and for how many months after each customer ' +
      'joined (null: none in this Market). `months`: the last 12 months in the Market’s zone, ' +
      'per currency, the commission the standard rate would have taken on those lines less what ' +
      'was taken, less what that month’s refunds gave back (so a month can be negative). ' +
      '`thisMonth` is the last of them.',
  })
  @ApiOkResponse({ type: ExclusiveCommissionBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'commission-payouts.rate-unavailable' })
  async own(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ExclusiveCommissionBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    this.#logger.log({
      msg: 'commission-payouts.view-own-exclusive-commission-route',
      outcome: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return exclusiveCommissionBody(result.value);
  }
}
