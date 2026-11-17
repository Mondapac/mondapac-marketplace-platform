import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
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
import { AdminCustomerOverview } from '../application/use-cases/admin-customer-overview.use-case';
import { AdminCustomerTabOpened } from '../application/use-cases/admin-customer-tab-opened.use-case';
import { AdminCustomersExport } from '../application/use-cases/admin-customers-export.use-case';
import { AdminCustomersIds } from '../application/use-cases/admin-customers-ids.use-case';
import { AdminCustomersList } from '../application/use-cases/admin-customers-list.use-case';
import { AdminSavedFilterCreate } from '../application/use-cases/admin-saved-filter-create.use-case';
import { AdminSavedFilterDelete } from '../application/use-cases/admin-saved-filter-delete.use-case';
import { AdminSavedFilterUpdate } from '../application/use-cases/admin-saved-filter-update.use-case';
import { AdminSavedFiltersList } from '../application/use-cases/admin-saved-filters-list.use-case';
import { CUSTOMERS_EXPORT_STEP_UP } from '../contracts/step-up';
import { closedBody, refusal } from './http-answers';
import { writeChunks } from './write-chunks';

const ERROR = { type: Object };
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'access.unauthenticated or session.invalid';

const SELECTOR_KEYS = ['view', 'q', 'filters'] as const;

/**
 * The admin Customers super list over HTTP: the list with its tabs, search, filters, sort and
 * paging, "select all matching", the export and the saved filters. Every answer is
 * `Cache-Control: no-store` (personal data); a write needs the CSRF token.
 */
@ApiTags('customers')
@RoutePopulation('admin')
@ReadsSession()
@Controller('customers/admin')
export class AdminCustomersController {
  readonly #logger = new Logger('AdminCustomersController');

  constructor(
    private readonly list: AdminCustomersList,
    private readonly ids: AdminCustomersIds,
    private readonly exportCustomers: AdminCustomersExport,
    private readonly filtersList: AdminSavedFiltersList,
    private readonly filterCreate: AdminSavedFilterCreate,
    private readonly filterUpdate: AdminSavedFilterUpdate,
    private readonly filterDelete: AdminSavedFilterDelete,
    private readonly overview: AdminCustomerOverview,
    private readonly tabOpened: AdminCustomerTabOpened,
  ) {}

  @Post('list')
  @HttpCode(200)
  @ApiOperation({
    summary: 'List the Market’s customers (super list)',
    description:
      'Needs customers.customers.view. Body: `view` (all, new, active, inactive, never-ordered, ' +
      'disabled, pending-deletion), `q` (2 to 80 characters: a sign-in address prefix or a part of ' +
      'the display name), `filters` (status, verified, joinedFrom, joinedTo, lastOrderFrom, ' +
      'lastOrderTo, ordersMin, ordersMax, spentMin, spentMax in minor units), `sort` (joined, name, ' +
      'email, last-order, orders, spent) and `direction`. With `page` (and `pageSize`, at most 100) ' +
      'the answer carries `paging.total` (the page-number mode of the List paging setting, at most ' +
      '10,000 rows deep); without it `cursor` and `limit` read the next page without a total. ' +
      '`counts` is the size of every tab. The rows are personal data.',
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
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, [
      ...SELECTOR_KEYS,
      'sort',
      'direction',
      'page',
      'pageSize',
      'cursor',
      'limit',
    ]);
    if (checked instanceof HttpException) throw checked;
    const result = await this.list.execute(context, body);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Post('list/ids')
  @HttpCode(200)
  @ApiOperation({
    summary: 'The account ids the list matches ("select all matching")',
    description:
      'Needs customers.customers.view. Body: `view`, `q`, `filters` as for the list. At most 10,000 ' +
      'ids; more is refused with the total (batch.too-large) and the admin narrows the filter.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max, total)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async matchingIds(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, SELECTOR_KEYS);
    if (checked instanceof HttpException) throw checked;
    const result = await this.ids.execute(context, body);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Post('export')
  @HttpCode(200)
  @RequiresStepUp('customers.customers.export')
  @ApiOperation({
    summary: 'Export customers as a CSV or XLSX file',
    description:
      'Needs customers.customers.view and customers.customers.export (protected) and a fresh two-step proof of this admin session ' +
      `for \`${CUSTOMERS_EXPORT_STEP_UP}\` (POST /identity/admin/step-up/verify, valid 5 minutes, spent ` +
      'by the export). Body: `format` (csv, the default, or xlsx), `columns` (an array of name, status, ' +
      'verified, joined, last-order, orders, spent, currency, refunds in the order shown; default all; ' +
      'email is always first) and the customers: `ids` (at most 1000) or `view`, `q`, `filters` as for ' +
      'the list, at most 10,000. The file streams as an attachment; the export is audited (format and ' +
      'count only).',
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
  async download(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res() response: Response,
    @Body() body: unknown,
  ): Promise<void> {
    const checked = closedBody(request, body, ['format', 'columns', 'ids', ...SELECTOR_KEYS]);
    const result =
      checked instanceof HttpException ? null : await this.exportCustomers.execute(context, body);
    if (checked instanceof HttpException || (result !== null && !result.ok)) {
      const error =
        checked instanceof HttpException
          ? checked
          : refusal((result as { error: { code: string } }).error, context, this.#logger);
      response
        .status(error.getStatus())
        .setHeader('Cache-Control', 'no-store')
        .json(error.getResponse());
      return;
    }
    if (result === null || !result.ok) return;
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
        msg: 'customers.admin-customers-export',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
  }

  @Get('saved-filters')
  @ApiOperation({
    summary: 'List the saved filters of the Customers list',
    description:
      'Needs customers.customers.view. Query `listKey` (admin.customers.customers or admin.customers.seller-attributions). The caller’s own ' +
      'filters first, then the ones shared with everyone by other admins.',
  })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async listFilters(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.filtersList.execute(context, { ...query });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return JSON.parse(JSON.stringify(result.value));
  }

  @Post('saved-filters')
  @ApiOperation({
    summary: 'Save the tab, search, filters and sort of the Customers list under a name',
    description:
      'Needs customers.customers.view. `payload` is a closed document (v 1, view, optional q, ' +
      'filters, sort, direction). At most 50 filters per account (saved-filter.limit-reached); ' +
      '`visibility` is me or everyone, and everyone also needs customers.saved-filter.share (else ' +
      'access.denied; at most 20 shared, saved-filter.shared-limit-reached); a filter shared with ' +
      'everyone is audited. A name is one per owner, whatever its case (saved-filter.name-taken).',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({ ...ERROR, description: 'saved-filter.name-taken or a limit' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async createFilter(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, ['listKey', 'name', 'visibility', 'payload']);
    if (checked instanceof HttpException) throw checked;
    const result = await this.filterCreate.execute(context, body);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return JSON.parse(JSON.stringify(result.value));
  }

  @Put('saved-filters/:id')
  @ApiOperation({
    summary: 'Rename a saved filter and set who can use it',
    description:
      'Needs customers.customers.view. The document of a filter never changes. The owner may ' +
      'always; any admin with customers.saved-filter.share may also change a filter shared with ' +
      'everyone; making a filter everyone needs that key for anybody; changes to or from everyone ' +
      'are audited. A filter the caller cannot see is saved-filter.not-found.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'saved-filter.not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'saved-filter.name-taken or shared-limit-reached' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async updateFilter(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, ['name', 'visibility']);
    if (checked instanceof HttpException) throw checked;
    const result = await this.filterUpdate.execute(context, { ...(body as object), id });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return JSON.parse(JSON.stringify(result.value));
  }

  @Delete('saved-filters/:id')
  @ApiOperation({
    summary: 'Delete a saved filter',
    description: 'Needs customers.customers.view. Who may: as for the rename.',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: Object })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'saved-filter.not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async deleteFilter(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.filterDelete.execute(context, { id });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Get('customers/:accountId')
  @ApiOperation({
    summary: 'One customer: the header and the Overview tab',
    description:
      'Needs customers.customers.view. The profile (sign-in address, name, status, email verified, ' +
      'joined) and what the orders add up to (count, spent, refunds, first and last order). The ' +
      'wallet balance, the orders (`GET ordering/admin/orders?accountId=`) and the money tab are ' +
      'read from their owning modules, each under its own permission. Every open is audited. ' +
      '404 customers.customer-not-found for a customer of another Market, or none. Personal data.',
  })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.customer-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async customer(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.overview.execute(context, { accountId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Post('customers/:accountId/tab-opened')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Record that the Orders or Money tab of a customer’s page was opened',
    description:
      'Needs customers.customers.view. Body: `tab` (orders or money). Writes the audit row of the ' +
      'open (the tab only, never the customer’s data) and confirms the customer is in the Market ' +
      '(404 customers.customer-not-found). Call it when the tab opens, before reading its data from ' +
      'the owning module.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.customer-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async tabWasOpened(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, ['tab']);
    if (checked instanceof HttpException) throw checked;
    const result = await this.tabOpened.execute(context, { ...(body as object), accountId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }
}
