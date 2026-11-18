import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiQuery,
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
import { AdminListDocuments } from '../application/use-cases/admin-list-documents.use-case';
import { AdminExportDocuments } from '../application/use-cases/admin-export-documents.use-case';
import { sendOrdersExport } from './export-response';
import { DOCUMENT_KINDS, DOCUMENT_SORT_KEYS } from '../domain/admin-document-list';
import { DocumentListPageBody, documentListPageBody } from './admin-document-list.dto';
import { refusal } from './http-answers';

const ERROR = { type: Object };

const parseWhole = (value: unknown): number | undefined =>
  value === undefined
    ? undefined
    : typeof value === 'string' && /^[0-9]{1,6}$/.test(value)
      ? Number(value)
      : -1;

/**
 * The admin Invoices list (Sales > Invoices): order confirmations of paid seller orders and credit
 * notes of succeeded refunds, one kind per page (owner decision 2026-11-15). Neither is a numbered
 * tax invoice yet. Read only. The controller authenticates only; the use case's gate needs
 * `ordering.order.view`. Every response is `Cache-Control: no-store`.
 */
@ApiTags('ordering')
@RoutePopulation('admin')
@ReadsSession()
@Controller('ordering/admin/documents')
export class AdminDocumentsController {
  readonly #logger = new Logger('AdminDocumentsController');

  constructor(
    private readonly list: AdminListDocuments,
    private readonly exportList: AdminExportDocuments,
  ) {}

  @Get()
  @ApiOperation({
    summary: "The Market's order confirmations or credit notes, newest first (admin)",
    description:
      'Needs ordering.order.view. One kind per page. Follows the List paging setting: page ' +
      'numbers with a total (page x pageSize may not pass 10,000, `too-deep`), or ' +
      'Previous/Next with `cursor` and `limit`, which also reaches rows past 10,000.',
  })
  @ApiQuery({
    name: 'kind',
    required: false,
    enum: DOCUMENT_KINDS,
    description: 'Default order-confirmation.',
  })
  @ApiQuery({ name: 'page', required: false, description: 'From 1; default 1.' })
  @ApiQuery({ name: 'pageSize', required: false, description: '1 to 100; default 25.' })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description:
      'Previous/Next paging (List paging prev-next, or past row 10,000): the nextCursor of the ' +
      'page before. Newest first; not with page, pageSize, sort or direction.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Previous/Next paging: 1 to 100 rows; default 25.',
  })
  @ApiQuery({ name: 'sort', required: false, enum: DOCUMENT_SORT_KEYS })
  @ApiQuery({ name: 'direction', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'An order, seller order, credit note or refund id, exact.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description:
      'Customer name or store name, 2 to 80 characters. Customer names need ' +
      'identity.customer-account.view; without it only store names match.',
  })
  @ApiQuery({ name: 'sellerId', required: false, description: "One seller's documents." })
  @ApiQuery({ name: 'from', required: false, description: 'ISO instant: issued at or after.' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO instant: issued before.' })
  @ApiQuery({ name: 'minAmount', required: false, description: 'Total, minor units, included.' })
  @ApiQuery({ name: 'maxAmount', required: false, description: 'Total, minor units, included.' })
  @ApiOkResponse({ type: DocumentListPageBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'access.unavailable, or ordering.search-unavailable when `search` could not run',
  })
  async documents(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, {
      kind: query['kind'],
      page: parseWhole(query['page']),
      pageSize: parseWhole(query['pageSize']),
      cursor: query['cursor'],
      limit: parseWhole(query['limit']),
      sort: query['sort'],
      direction: query['direction'],
      q: query['q'],
      search: query['search'],
      sellerId: query['sellerId'],
      from: query['from'],
      to: query['to'],
      minAmount: query['minAmount'],
      maxAmount: query['maxAmount'],
    });
    this.#logger.log({
      msg: 'ordering.admin-list-documents-route',
      outcome: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return documentListPageBody(result.value);
  }

  @Get('export')
  @ApiOperation({
    summary: 'The order confirmations or credit notes of the list as a CSV or XLSX file (admin)',
    description:
      'Needs ordering.order.view. The selected rows (`ids`) or every row matching ' +
      'the same filter as the list (kind, q, search, sellerId, from, to, minAmount, maxAmount), ' +
      'newest first, at most 10,000: more is 413 batch.too-large (details.max, details.total) and ' +
      'the filter is narrowed. No paging or sort keys. Columns: the fixed ones (order) and ' +
      'the `columns` given, in that order; without `columns`, every column. A money value is ' +
      'two columns (a plain decimal in major units, then its currency); times are ISO 8601 ' +
      'with the offset of `zone`. Customer name and email only with ' +
      'identity.customer-account.view (empty cells otherwise). Streams as an attachment: ' +
      'order-confirmations-<day> or credit-notes-<day>, .csv|xlsx (never "invoices": these are not tax invoices). CSV text cells that start with = + - @ get a leading quote; XLSX cells are ' +
      'all strings.',
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'xlsx'] })
  @ApiQuery({
    name: 'columns',
    required: false,
    description:
      'Comma-separated, in the order shown: sellerOrderId, store, customer, issued, total, tax, shipping; credit notes also documentId, refundId, reason (accepted and skipped on confirmations).',
  })
  @ApiQuery({
    name: 'ids',
    required: false,
    description:
      'Comma-separated seller order ids for confirmations, credit note ids for credit notes, at most 200, with or instead of the filter.',
  })
  @ApiQuery({
    name: 'zone',
    required: false,
    description: "IANA time zone of the times and the file's day; default the Market's.",
  })
  @ApiOkResponse({ description: 'text/csv; charset=utf-8 or an .xlsx workbook, as an attachment' })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'access.unavailable, or ordering.search-unavailable when `search` could not run',
  })
  async download(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.exportList.execute(context, { ...query });
    this.#logger.log({
      msg: 'ordering.admin-export-documents-route',
      outcome: result.ok ? 'exported' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    await sendOrdersExport(
      result,
      context,
      response,
      this.#logger,
      'ordering.admin-export-documents',
    );
  }
}
