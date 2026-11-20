import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AdminSellerCustomersList } from '../application/use-cases/admin-seller-customers-list.use-case';
import { AdminSellerCustomersSummary } from '../application/use-cases/admin-seller-customers-summary.use-case';
import { closedBody, refusal } from './http-answers';

const ERROR = { type: Object };
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'access.unauthenticated or session.invalid';

/**
 * The Customers tab of a seller's page in the admin panel (customers management phase 3): its
 * counts and monthly trend, and the seller's customers as a super list. `no-store` answers.
 */
@ApiTags('customers')
@RoutePopulation('admin')
@ReadsSession()
@Controller('customers/admin/sellers/:sellerId/customers')
export class AdminSellerCustomersController {
  readonly #logger = new Logger('AdminSellerCustomersController');

  constructor(
    private readonly list: AdminSellerCustomersList,
    private readonly summary: AdminSellerCustomersSummary,
  ) {}

  @Get('summary')
  @ApiOperation({
    summary: 'The counts and monthly trend of a seller’s customers',
    description:
      'Needs customers.customers.view. `counts` (all, buyers, followers, and referred: the ' +
      'seller’s exclusive customers, whose attribution is active) and, for the last 12 months in ' +
      'the Market’s zone (`zone`), new buyers (first order), new followers and new exclusive ' +
      'customers (`newExclusive`: joined through the invite link that month, attribution active).',
  })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async counts(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('sellerId') sellerId: string,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.summary.execute(context, { sellerId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Post('list')
  @HttpCode(200)
  @ApiOperation({
    summary: 'List a seller’s customers (super list)',
    description:
      'Needs customers.customers.view. Body as the seller’s own list (view, q by customer code, ' +
      'filters, sort, direction, page and pageSize or cursor and limit); each row also carries the ' +
      '`accountId` for the link to the customer’s page.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async listCustomers(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('sellerId') sellerId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, [
      'view',
      'q',
      'filters',
      'sort',
      'direction',
      'page',
      'pageSize',
      'cursor',
      'limit',
    ]);
    if (checked instanceof HttpException) throw checked;
    const result = await this.list.execute(context, { ...(body as object), sellerId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }
}
