import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Post,
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
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AdminOfferPostReviewApprove } from '../application/use-cases/offer-post-review-approve.use-case';
import { AdminOfferPostReviewTakeDown } from '../application/use-cases/offer-post-review-take-down.use-case';
import { AdminOfferPostReviewView } from '../application/use-cases/admin-offer-post-review-view.use-case';
import { AdminOfferPostReviewsBulkApprove } from '../application/use-cases/offer-post-reviews-bulk-approve.use-case';
import { AdminOfferPostReviewsExport } from '../application/use-cases/admin-offer-post-reviews-export.use-case';
import { AdminOfferPostReviewsList } from '../application/use-cases/admin-offer-post-reviews-list.use-case';
import { OFFER_CHANGE_REASONS } from '../domain/events';
import { OFFER_POST_REVIEW_REASONS } from '../domain/offer-post-review';
import { closedBody, numericQuery, refusalWith } from './http-answers';
import {
  OfferPostReviewApproveRequest,
  OfferPostReviewDecidedDto,
  OfferPostReviewsBulkApproveDto,
  OfferPostReviewsBulkApproveRequest,
  OfferPostReviewsListDto,
  OfferPostReviewTakeDownRequest,
  OfferPostReviewViewDto,
} from './offer-post-review.dto';
import { ApiErrorBody } from './platform-product.dto';
import { writeChunks } from './write-chunks';

/**
 * The HTTP status of each refusal of the post-publication review routes (slice 6): a malformed
 * request is 400; an unknown row 404; a decision on a state that has moved on (decided, stale, an
 * Offer that is not live) 409; the decider's own submission 403; a missing dependency 503.
 */
export const OFFER_POST_REVIEW_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'post-review.not-found': 404,
  'post-review.not-open': 409,
  'offer.not-live': 409,
  'conflict.stale': 409,
  'post-review.own-submission': 403,
  'batch.too-large': 413,
  'access.unavailable': 503,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

const LIST_QUERIES = [
  {
    name: 'status',
    enum: ['open', 'approved', 'taken-down', 'all'],
    description: 'The view; `open` by default.',
  },
  {
    name: 'reasons',
    description: `Comma-separated reasons, any of: ${OFFER_POST_REVIEW_REASONS.join(', ')}.`,
  },
  { name: 'sellerId', description: "One seller's rows (uuid)." },
  { name: 'categoryId', description: "A platform category of the product's published revision." },
  { name: 'openedFrom', description: 'ISO 8601 instant; opened at or after it (inclusive).' },
  { name: 'openedTo', description: 'ISO 8601 instant; opened before it (exclusive).' },
  {
    name: 'q',
    description:
      'Search text, 2 to 100 characters after trimming: product name (published, Market default ' +
      'locale), product code or seller public store name; % and _ are matched as typed.',
  },
] as const;

function ListQueries(): MethodDecorator {
  return (target, key, descriptor) => {
    for (const query of LIST_QUERIES) {
      ApiQuery({ required: false, ...query })(target, key, descriptor);
    }
  };
}

/**
 * The post-publication review list over HTTP (risk-based Offer approval slice 6): list, export
 * and read the rows, approve one or up to 50, or take an Offer down. Admin routes read the admin
 * session (`@ReadsSession`), so decisions need the CSRF token and the admin panel's origin; JSON
 * only, closed bodies. A thin adapter: one use case does the work through its gate. Each route
 * logs its outcome code, the Market and the correlation id only (never the note).
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/offer-post-reviews')
export class OfferPostReviewController {
  readonly #logger = new Logger('OfferPostReviewController');

  constructor(
    private readonly listReviews: AdminOfferPostReviewsList,
    private readonly exportReviews: AdminOfferPostReviewsExport,
    private readonly viewReview: AdminOfferPostReviewView,
    private readonly approveReview: AdminOfferPostReviewApprove,
    private readonly takeDownReview: AdminOfferPostReviewTakeDown,
    private readonly bulkApproveReviews: AdminOfferPostReviewsBulkApprove,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the published Offers on the post-publication review list',
    description:
      'Needs catalog.product.view. A super list: `sort` (opened | decided), `direction` (asc ' +
      'default), `page` (1 to 20), `pageSize` (1 to 50) and `paging` (the Market "List paging" ' +
      'setting; `pages` gives `total`). Filters compose. `totalOpen` is the tab count, `sellers` ' +
      'the seller filter options. Reason codes only: no price or median, never the note.',
  })
  @ApiQuery({ name: 'sort', required: false, enum: ['opened', 'decided'] })
  @ApiQuery({ name: 'direction', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'page', required: false, description: 'Page number, 1 to 20.' })
  @ApiQuery({ name: 'pageSize', required: false, description: '1 to 50, default 25.' })
  @ApiQuery({ name: 'paging', required: false, enum: ['pages', 'prev-next'] })
  @ListQueries()
  @ApiOkResponse({ type: OfferPostReviewsListDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<OfferPostReviewsListDto> {
    const result = await this.listReviews.execute(context, numericQuery(query));
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as OfferPostReviewsListDto)
      : refusalWith(OFFER_POST_REVIEW_STATUS, result.error, response, context);
    return this.settle('catalog.admin-offer-post-reviews-list', context, outcome);
  }

  @Get('export')
  @ReadsSession()
  @ApiOperation({
    summary: 'Export the post-publication review list as a file',
    description:
      'Needs catalog.product.view. The rows of the list for the same filters and sort, as csv ' +
      '(default) or xlsx: post_review_id, status, reasons, sample_percent, sample_doubled, ' +
      'offer_id, offer_status, listed, seller_sku, product_id, product_name, seller_id, ' +
      'store_name, opened_at, decided_at, decision_reason, misconduct. Codes and labels only, ' +
      'never the note. At most 1,000 rows (more is batch.too-large). CSV: a text cell that ' +
      'starts with = + - @ gets a leading quote; XLSX cells are strings.',
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'xlsx'] })
  @ApiQuery({ name: 'sort', required: false, enum: ['opened', 'decided'] })
  @ApiQuery({ name: 'direction', required: false, enum: ['asc', 'desc'] })
  @ListQueries()
  @ApiOkResponse({
    description:
      'text/csv; charset=utf-8 (offer-post-reviews-<date>.csv) or ' +
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet (.xlsx), as an attachment',
  })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiPayloadTooLargeResponse({ type: ApiErrorBody, description: 'batch.too-large' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async download(
    @Call() context: CallContext,
    @Res() response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.exportReviews.execute(context, query);
    const log = (outcome: string): void =>
      this.#logger.log({
        msg: 'catalog.admin-offer-post-reviews-export',
        outcome,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
    if (!result.ok) {
      const error = refusalWith(OFFER_POST_REVIEW_STATUS, result.error, response, context);
      log((error.getResponse() as { code: string }).code);
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
      log('ok');
    } catch {
      log('stream-failed');
      response.destroy();
    }
  }

  @Post('bulk-approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Approve up to 50 rows of the post-publication review list',
    description:
      'Needs catalog.product.approve. Each row runs the single approve in its own unit; a row ' +
      'that is not decidable now (post-review.not-open, post-review.not-found, conflict.stale, ' +
      'post-review.own-submission) is skipped with its code. No bulk take-down.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: OfferPostReviewsBulkApproveRequest })
  @ApiOkResponse({ type: OfferPostReviewsBulkApproveDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiPayloadTooLargeResponse({ type: ApiErrorBody, description: 'batch.too-large (details.max)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async bulkApprove(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<OfferPostReviewsBulkApproveDto> {
    const input = closedBody(request, body, ['items']);
    let outcome: OfferPostReviewsBulkApproveDto | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.bulkApproveReviews.execute(context, { items: input.items });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as OfferPostReviewsBulkApproveDto)
        : refusalWith(OFFER_POST_REVIEW_STATUS, result.error, response, context);
    }
    return this.settle('catalog.offer-post-reviews-bulk-approve', context, outcome);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Read one row of the post-publication review list',
    description:
      'Needs catalog.product.view. The row in any status, as the list shows it, plus `note` ' +
      "for a caller holding catalog.product.approve. Another Market's row is " +
      'post-review.not-found.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: OfferPostReviewViewDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'post-review.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async view(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
  ): Promise<OfferPostReviewViewDto> {
    const result = await this.viewReview.execute(context, { id });
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as OfferPostReviewViewDto)
      : refusalWith(OFFER_POST_REVIEW_STATUS, result.error, response, context);
    return this.settle('catalog.admin-offer-post-review-view', context, outcome);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Approve a row of the post-publication review list',
    description:
      'Needs catalog.product.approve. Closes the open row; the Offer stays as it is (also one ' +
      'that is no longer live). Body `{ version, note? }` (note 1 to 2000 characters).',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ type: OfferPostReviewApproveRequest })
  @ApiOkResponse({ type: OfferPostReviewDecidedDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description:
      'access.denied, request.csrf or post-review.own-submission (the decider submitted the ' +
      'Offer, or acts for its seller in a Login-as-Seller session)',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'post-review.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'post-review.not-open or conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async approve(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<OfferPostReviewDecidedDto> {
    const input = closedBody(request, body, ['version'], ['note']);
    let outcome: OfferPostReviewDecidedDto | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.approveReview.execute(context, {
        id,
        version: input.version,
        ...(Object.hasOwn(input, 'note') ? { note: input.note } : {}),
      });
      outcome = result.ok
        ? { ...result.value }
        : refusalWith(OFFER_POST_REVIEW_STATUS, result.error, response, context);
    }
    return this.settle('catalog.offer-post-review-approve', context, outcome);
  }

  @Post(':id/take-down')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Take a published Offer down after publication',
    description:
      'Needs catalog.product.approve and catalog.product.delete; refused in a Login-as-Seller ' +
      'session. The Offer goes off sale at once (Changes needed; open carts answer ' +
      'offer-unavailable, placed orders are untouched) and the seller is told to fix it and ' +
      'submit again; a held edit is superseded; `misconduct: true` revokes the seller’s ' +
      `Trusted. Body \`{ version, reasonCode (${OFFER_CHANGE_REASONS.join(' | ')}), ` +
      'misconduct, note (1 to 2000 characters) }`.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ type: OfferPostReviewTakeDownRequest })
  @ApiOkResponse({ type: OfferPostReviewDecidedDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description:
      'access.denied (also any Login-as-Seller session), request.csrf or ' +
      'post-review.own-submission',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'post-review.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'post-review.not-open, offer.not-live (approve to close the row) or conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async takeDown(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<OfferPostReviewDecidedDto> {
    const input = closedBody(request, body, ['version', 'reasonCode', 'misconduct', 'note']);
    let outcome: OfferPostReviewDecidedDto | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.takeDownReview.execute(context, {
        id,
        version: input.version,
        reasonCode: input.reasonCode,
        misconduct: input.misconduct,
        note: input.note,
      });
      outcome = result.ok
        ? { ...result.value }
        : refusalWith(OFFER_POST_REVIEW_STATUS, result.error, response, context);
    }
    return this.settle('catalog.offer-post-review-take-down', context, outcome);
  }

  private settle<T extends object>(
    msg: string,
    context: CallContext,
    outcome: T | HttpException,
  ): T {
    const failed = outcome instanceof HttpException && outcome.getStatus() >= 500;
    this.#logger[failed ? 'warn' : 'log']({
      msg,
      outcome:
        outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
