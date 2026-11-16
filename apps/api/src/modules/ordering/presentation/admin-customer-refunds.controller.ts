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
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { RequiresStepUp } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { writeChunks } from '../../../platform/list-export';
import { CUSTOMER_DATA_EXPORT_STEP_UP } from '../application/customer-refunds-list-flow';
import { AdminCustomerRefundsExport } from '../application/use-cases/admin-customer-refunds-export.use-case';
import { AdminCustomerRefundsList } from '../application/use-cases/admin-customer-refunds-list.use-case';
import { AdminCustomerRefunds } from '../application/use-cases/admin-customer-refunds.use-case';
import { closedBody, refusal } from './http-answers';
import { refundBody } from './refunds.dto';

const ERROR = { type: Object };
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'access.unauthenticated or session.invalid';
const FILTERS =
  '`filters` (`state`: an array of pending, succeeded, failed; `reason`: an array of refund ' +
  'reason codes; `from`, `to`: ISO 8601 instants, requested at or after `from` and before `to`; ' +
  'the panel turns the admin’s local days into instants)';

/** The refunds of one customer's orders, for the Money tab of the customer's page. */
@ApiTags('ordering')
@RoutePopulation('admin')
@ReadsSession()
@Controller('ordering/admin/customers')
export class AdminCustomerRefundsController {
  readonly #logger = new Logger('AdminCustomerRefundsController');

  constructor(
    private readonly refunds: AdminCustomerRefunds,
    private readonly list: AdminCustomerRefundsList,
    private readonly listExport: AdminCustomerRefundsExport,
  ) {}

  @Get(':accountId/refunds')
  @ApiOperation({
    summary: 'The refunds of one customer’s orders, newest first (admin)',
    description:
      'Needs ordering.order.view. At most 100, each with its credit note id when it succeeded. ' +
      'A customer with no order has none. Ids, codes, amounts and instants only. The super list ' +
      'is `POST ordering/admin/customers/:accountId/refunds`.',
  })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async newest(
    @Call() context: CallContext,
    @Param('accountId') accountId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.refunds.execute(context, { accountId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return { refunds: result.value.refunds.map(refundBody) };
  }

  @Post(':accountId/refunds')
  @HttpCode(200)
  @ApiOperation({
    summary: 'The refunds of one customer’s orders (super list, admin)',
    description:
      `Needs ordering.order.view. Body: ${FILTERS}, \`sort\` (requested, the default, or amount), ` +
      '`direction` (desc, the default, or asc), `page`, `pageSize` (at most 100) and `paging` ' +
      '(pages, with the total, or prev-next: the Market’s List paging setting). Each refund with ' +
      'its credit note id when it succeeded; ids, codes, amounts and instants only.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async page(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, [
      'filters',
      'sort',
      'direction',
      'page',
      'pageSize',
      'paging',
    ]);
    if (checked !== null) throw checked;
    const result = await this.list.execute(context, { ...(body as object), accountId });
    if (!result.ok) {
      throw refusal(
        result.error as { readonly code: string } & Record<string, unknown>,
        context,
        this.#logger,
      );
    }
    return { ...result.value, items: result.value.items.map(refundBody) };
  }

  @Post(':accountId/refunds/export')
  @HttpCode(200)
  @RequiresStepUp(CUSTOMER_DATA_EXPORT_STEP_UP)
  @ApiOperation({
    summary: 'Export the refunds of one customer’s orders as a CSV or XLSX file (admin)',
    description:
      'Needs ordering.order.view and customers.customers.export (protected) and a fresh two-step ' +
      `proof for \`${CUSTOMER_DATA_EXPORT_STEP_UP}\` (spent by the export). Body: \`format\` (csv, ` +
      `the default, or xlsx), ${FILTERS}, \`sort\` and \`direction\`. At most 10,000 refunds. ` +
      'Audited (format and count).',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ description: 'text/csv or the .xlsx content type, as an attachment' })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    ...ERROR,
    description: 'access.denied, request.csrf, second-factor.required or enrolment-required',
  })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max, total)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async export(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res() response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const checked = closedBody(request, body, ['format', 'filters', 'sort', 'direction']);
    const result =
      checked !== null
        ? null
        : await this.listExport.execute(context, { ...(body as object), accountId });
    if (checked !== null || result === null || !result.ok) {
      const error: HttpException =
        checked ??
        refusal(
          (result as { error: { code: string } & Record<string, unknown> }).error,
          context,
          this.#logger,
        );
      response
        .status(error.getStatus())
        .setHeader('Cache-Control', 'no-store')
        .json(error.getResponse());
      return;
    }
    const { filename, contentType, chunks } = result.value;
    response.status(200);
    response.setHeader('Content-Type', contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await writeChunks(response, chunks);
    } catch {
      this.#logger.warn({
        msg: 'ordering.admin-customer-refunds-export',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
  }
}
