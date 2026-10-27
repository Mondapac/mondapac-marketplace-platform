import { Controller, Get, Logger, Res } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ViewAccountDeletionAvailability } from '../application/use-cases/view-account-deletion-availability.use-case';
import { AccountDeletionAvailabilityBody } from './account-deletion.dto';
import { refusal } from './http-answers';

const ERROR = { type: Object };

/**
 * What the signed-in customer's own screens may read about account deletion: whether it is on in
 * their Market and how long a request waits. The customer comes from the session. `no-store`.
 */
@ApiTags('customers')
@RoutePopulation('customer')
@ReadsSession()
@Controller('customers/me/account-deletion')
export class AccountDeletionController {
  readonly #logger = new Logger('AccountDeletionController');

  constructor(private readonly availability: ViewAccountDeletionAvailability) {}

  @Get()
  @ApiOperation({
    summary: 'Whether the customer may delete their account',
    description:
      'Customer sessions only. canDeleteAccount is false while the Market has switched ' +
      'deletion off; waitingPeriodDays is the wait of a request.',
  })
  @ApiOkResponse({ type: AccountDeletionAvailabilityBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async one(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.availability.execute(context, {});
    this.#logger.log({
      msg: 'customers.view-account-deletion-availability-route',
      outcome: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }
}
