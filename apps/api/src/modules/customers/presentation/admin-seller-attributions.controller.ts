import { Body, Controller, HttpCode, HttpException, Logger, Post, Req, Res } from '@nestjs/common';
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
import { AdminSellerAttributionsDecide } from '../application/use-cases/admin-seller-attributions-decide.use-case';
import { AdminSellerAttributionsExport } from '../application/use-cases/admin-seller-attributions-export.use-case';
import { AdminSellerAttributionsIds } from '../application/use-cases/admin-seller-attributions-ids.use-case';
import { AdminSellerAttributionsList } from '../application/use-cases/admin-seller-attributions-list.use-case';
import { CUSTOMERS_EXPORT_STEP_UP } from '../contracts/step-up';
import { closedBody, refusal } from './http-answers';
import { writeChunks } from './write-chunks';

const ERROR = { type: Object };
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'access.unauthenticated or session.invalid';
const SELECTOR_KEYS = ['view', 'q', 'filters'] as const;

/**
 * The admin's list of customers attributed to a seller through an invite link (customers
 * management phase 4a), a super list: the list, "select all matching", the export, and the
 * reject/restore decision. Saved filters use the Customers list's routes with
 * `listKey=admin.customers.seller-attributions`. Every answer is `Cache-Control: no-store`; a
 * write needs the CSRF token. List reads are POST because the filters are a JSON document.
 */
@ApiTags('customers')
@RoutePopulation('admin')
@ReadsSession()
@Controller('customers/admin/seller-attributions')
export class AdminSellerAttributionsController {
  readonly #logger = new Logger('AdminSellerAttributionsController');

  constructor(
    private readonly list: AdminSellerAttributionsList,
    private readonly ids: AdminSellerAttributionsIds,
    private readonly exportRows: AdminSellerAttributionsExport,
    private readonly decide: AdminSellerAttributionsDecide,
  ) {}

  @Post('list')
  @HttpCode(200)
  @ApiOperation({
    summary: 'List the seller attributions (super list)',
    description:
      'Needs customers.customers.view. Body: `view` (suspicious, the default: rejected or flagged; ' +
      'all; active; rejected), `q` (the start of the sign-in address, 2 to 254 characters), ' +
      '`filters` (sellerId, status, rejectReason: seller-team or admin, flag: link-burst, ' +
      'attributedFrom and attributedTo as YYYY-MM-DD UTC days), `direction` (desc, the default, or ' +
      'asc by attribution instant). With `page` (and `pageSize`, at most 100) the answer carries ' +
      '`paging.total`; without it `cursor` and `limit`. `counts` is the size of every view.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'customers.unavailable' })
  async listRows(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, [
      ...SELECTOR_KEYS,
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
    summary: 'The accounts the list matches ("select all matching")',
    description:
      'Needs customers.customers.view. Body: `view`, `q`, `filters` as for the list. At most 10,000 ' +
      'accounts; more is refused with the total (batch.too-large).',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max, total)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'customers.unavailable' })
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

  @Post('decide')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reject attributions or restore them',
    description:
      'Needs customers.customers.view and customers.seller-attributions.manage (protected). Body: ' +
      '`decision` (reject or restore) and `accountIds` (1 to 100). A rejected customer stops being ' +
      'the seller’s exclusive customer. One answer per account: changed, unchanged, not-found, or ' +
      'seller-team (rejected because the customer is on the seller’s team: not restorable). Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'customers.unavailable (also a concurrent decision on the same customer)',
  })
  async decision(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, ['decision', 'accountIds']);
    if (checked instanceof HttpException) throw checked;
    const result = await this.decide.execute(context, body);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Post('export')
  @HttpCode(200)
  @RequiresStepUp('customers.customers.export')
  @ApiOperation({
    summary: 'Export the attributions as a CSV or XLSX file',
    description:
      'Needs customers.customers.view and customers.customers.export (protected) and a fresh two-step ' +
      `proof of this admin session for \`${CUSTOMERS_EXPORT_STEP_UP}\`. Body: \`format\` (csv, the ` +
      'default, or xlsx) and the rows: `ids` (at most 1000) or `view`, `q`, `filters` as for the ' +
      'list, at most 10,000. Columns: email, name, account id, seller id, attributed at, status, ' +
      'reject reason, flags, decided at. Audited (format and count only).',
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
    const checked = closedBody(request, body, ['format', 'ids', ...SELECTOR_KEYS]);
    const result =
      checked instanceof HttpException ? null : await this.exportRows.execute(context, body);
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
        msg: 'customers.admin-seller-attributions-export',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
  }
}
