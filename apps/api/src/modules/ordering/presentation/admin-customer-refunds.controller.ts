import { Controller, Get, Logger, Param, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
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
import { AdminCustomerRefunds } from '../application/use-cases/admin-customer-refunds.use-case';
import { refusal } from './http-answers';
import { refundBody } from './refunds.dto';

const ERROR = { type: Object };

/** The refunds of one customer's orders, for the Money tab of the customer's page. */
@ApiTags('ordering')
@RoutePopulation('admin')
@ReadsSession()
@Controller('ordering/admin/customers')
export class AdminCustomerRefundsController {
  readonly #logger = new Logger('AdminCustomerRefundsController');

  constructor(private readonly refunds: AdminCustomerRefunds) {}

  @Get(':accountId/refunds')
  @ApiOperation({
    summary: 'The refunds of one customer’s orders, newest first (admin)',
    description:
      'Needs ordering.order.view. At most 100, each with its credit note id when it succeeded. ' +
      'A customer with no order has none. Ids, codes, amounts and instants only.',
  })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Param('accountId') accountId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.refunds.execute(context, { accountId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return { refunds: result.value.refunds.map(refundBody) };
  }
}
