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
  ApiPayloadTooLargeResponse,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
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
import { OfferApprove } from '../application/use-cases/offer-approve.use-case';
import { OfferRequestChanges } from '../application/use-cases/offer-request-changes.use-case';
import {
  REVIEW_QUEUE_KINDS,
  ReviewQueueList,
} from '../application/use-cases/review-queue-list.use-case';
import { ReviewQueueExport } from '../application/use-cases/review-queue-export.use-case';
import { AdminOfferChangeApprove } from '../application/use-cases/admin-offer-change-approve.use-case';
import { AdminOfferChangeReject } from '../application/use-cases/admin-offer-change-reject.use-case';
import { AdminOfferChangeRequestChanges } from '../application/use-cases/admin-offer-change-request-changes.use-case';
import { AdminOfferChangesList } from '../application/use-cases/admin-offer-changes-list.use-case';
import { AdminOfferChangesExport } from '../application/use-cases/admin-offer-changes-export.use-case';
import { AdminOfferChangeView } from '../application/use-cases/admin-offer-change-view.use-case';
import { OfferReviewStopsView } from '../application/use-cases/offer-review-stops-view.use-case';
import { OFFER_REVIEW_REASONS } from '../domain/offer-review-policy';
import { writeChunks } from './write-chunks';
import {
  closedBody,
  numericQuery,
  optionalClosedBody,
  pageQuery,
  refusalWith,
} from './http-answers';
import {
  OfferChangeApprovedDto,
  OfferChangeApproveRequest,
  OfferChangeDecidedDto,
  OfferChangeDecisionRequest,
  OfferChangeListItemDto,
  OfferChangesListDto,
  OfferReviewStopsDto,
} from './offer-change.dto';
import {
  OfferApproveRequest,
  OfferDecided,
  OfferRequestChangesRequest,
  ReviewQueueList as ReviewQueueListDto,
} from './offer-review.dto';
import { ApiErrorBody } from './platform-product.dto';

/**
 * The HTTP status of each refusal of the admin Offer review routes (catalog design 4.4, 8.2). A
 * malformed request is 400; an unknown Offer is 404; a decision on a state that has moved on (not
 * waiting any more, a stale version, an unpublished product, a seller who may not sell) is 409; a
 * claim in the description is 422; a missing dependency is 503.
 */
export const OFFER_REVIEW_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'offer.not-found': 404,
  'offer.not-pending-review': 409,
  'offer.product-not-published': 409,
  'seller.not-eligible': 409,
  'type.not-allowed': 409,
  'conflict.stale': 409,
  'conflict.retry': 409,
  'claim-text.refused': 422,
  'batch.too-large': 413,
  'access.unavailable': 503,
  'claim.check-unavailable': 503,
  // Held changes of live Offers (slice 2c).
  'offer-change.not-found': 404,
  'offer-change.not-pending': 409,
  'offer-change.own-submission': 403,
  'offer-change.invalid': 422,
  'claim.tag-not-allowed': 422,
});

/** The boolean filters of the queue arrive as text; any other text reaches the use case and fails. */
function flagQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out = { ...query };
  for (const key of ['firstPublication', 'hasImages']) {
    if (out[key] === 'true') out[key] = true;
    else if (out[key] === 'false') out[key] = false;
  }
  return out;
}

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/**
 * The review queue of Offers over HTTP (catalog design 4.4, 8.2, 9.2): list the Offers waiting for
 * their first publication, approve one, or send it back with a reason code. Admin routes read the
 * admin session (`@ReadsSession`), so decisions need the CSRF token and the admin panel's origin;
 * JSON only, closed bodies. A thin adapter: one use case does the work through its gate.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin')
export class OfferReviewController {
  readonly #logger = new Logger('OfferReviewController');

  constructor(
    private readonly queue: ReviewQueueList,
    private readonly approveOffer: OfferApprove,
    private readonly requestChanges: OfferRequestChanges,
    private readonly exportQueue: ReviewQueueExport,
    private readonly listChanges: AdminOfferChangesList,
    private readonly approveChange: AdminOfferChangeApprove,
    private readonly requestChangeChanges: AdminOfferChangeRequestChanges,
    private readonly rejectChange: AdminOfferChangeReject,
    private readonly exportChanges: AdminOfferChangesExport,
    private readonly viewChange: AdminOfferChangeView,
    private readonly viewStops: OfferReviewStopsView,
  ) {}

  @Get('review-queue')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the review queue: Offers and product revisions',
    description:
      'Needs catalog.product.view. Offers waiting for their first publication and pending ' +
      'product revisions, oldest submit first, keyset-paged: send `nextAfterId` of the previous ' +
      'page as `afterId`, with the same filters. `limit` is 1 to 50 (default 25). `kind` keeps ' +
      'one kind; `sellerId` one seller; `firstPublication` and `hasImages` keep product ' +
      'revisions only (refused with kind=offer-first-publication); `submittedFrom` (inclusive) and ' +
      '`submittedTo` (exclusive) keep the rows submitted in that window; `q` keeps the rows whose ' +
      'product name, product code or seller store name contains the text (any case; both kinds). ' +
      'Every filter composes with the others. `total` counts what the filters keep; `totals` is ' +
      'the whole queue per kind, whatever the filters. `searchCapped` is true when the store ' +
      'names of `q` matched more stores than can be searched (narrow the search).',
  })
  @ApiQuery({
    name: 'afterId',
    required: false,
    description: 'The last Offer id of the previous page.',
  })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 50, default 25.' })
  @ApiQuery({ name: 'sort', required: false, enum: ['submitted'] })
  @ApiQuery({ name: 'direction', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'page', required: false, description: 'Page number, 1 to 20.' })
  @ApiQuery({ name: 'pageSize', required: false, description: '1 to 50, default 25.' })
  @ApiQuery({
    name: 'paging',
    required: false,
    enum: ['pages', 'prev-next'],
    description: 'The Market "List paging" setting; `prev-next` gives no total.',
  })
  @ApiQuery({ name: 'kind', required: false, enum: REVIEW_QUEUE_KINDS })
  @ApiQuery({ name: 'sellerId', required: false, description: "One seller's rows only (uuid)." })
  @ApiQuery({
    name: 'firstPublication',
    required: false,
    enum: ['true', 'false'],
    description: 'Product revisions only: a first publication or an update.',
  })
  @ApiQuery({
    name: 'hasImages',
    required: false,
    enum: ['true', 'false'],
    description:
      'Product revisions only: the pending revision lists a photo (any state, as the row field) ' +
      'or none.',
  })
  @ApiQuery({
    name: 'submittedFrom',
    required: false,
    description:
      'ISO 8601 instant with an offset or Z; rows submitted at or after it (inclusive), both kinds.',
  })
  @ApiQuery({
    name: 'submittedTo',
    required: false,
    description:
      'ISO 8601 instant with an offset or Z; rows submitted before it (exclusive), after submittedFrom.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'Search text, 2 to 100 characters after trimming (else validation.failed, field q): keeps ' +
      'the rows whose product name (the one the row shows, in the Market default locale), ' +
      'product code or seller public store name contains it, case-insensitively; % and _ are ' +
      'matched as typed. Both kinds of row.',
  })
  @ApiOkResponse({ type: ReviewQueueListDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<ReviewQueueListDto> {
    const result = await this.queue.execute(context, numericQuery(flagQuery(pageQuery(query))));
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as ReviewQueueListDto)
      : refusalWith(OFFER_REVIEW_STATUS, result.error, response, context);
    return this.settle('catalog.review-queue-list', context, outcome);
  }

  @Get('review-queue/export')
  @ReadsSession()
  @ApiOperation({
    summary: 'Export the review queue as a file',
    description:
      'Needs catalog.product.view. The rows of the review queue for the same filters ' +
      '(`kind`, `sellerId`, `firstPublication`, `hasImages`, `submittedFrom`, `submittedTo` and ' +
      'the search text `q`), oldest submit first. `format` is csv (the default) or xlsx, with the same ' +
      'columns: kind, product_code, product_name, seller_id, store_name, seller_sku, ' +
      'first_publication, reasons, required_checks, has_images, warnings, submitted_at. At most ' +
      '1,000 rows (the pages the list reaches); a longer queue is refused whole as ' +
      'batch.too-large, never cut; a `q` whose store names match more stores than can be ' +
      'searched is refused as validation.failed (q, too-broad). The file is an attachment. CSV: a text cell that starts with ' +
      '= + - @ is written with a leading quote. XLSX: every cell is a string value, never a formula.',
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'xlsx'] })
  @ApiQuery({ name: 'kind', required: false, enum: REVIEW_QUEUE_KINDS })
  @ApiQuery({ name: 'sellerId', required: false })
  @ApiQuery({ name: 'firstPublication', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'hasImages', required: false, enum: ['true', 'false'] })
  @ApiQuery({
    name: 'submittedFrom',
    required: false,
    description:
      'ISO 8601 instant with an offset or Z; rows submitted at or after it (inclusive), both kinds.',
  })
  @ApiQuery({
    name: 'submittedTo',
    required: false,
    description:
      'ISO 8601 instant with an offset or Z; rows submitted before it (exclusive), after submittedFrom.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'Search text, 2 to 100 characters after trimming (else validation.failed, field q): keeps ' +
      'the rows whose product name (the one the row shows, in the Market default locale), ' +
      'product code or seller public store name contains it, case-insensitively; % and _ are ' +
      'matched as typed. Both kinds of row.',
  })
  @ApiOkResponse({
    description:
      'text/csv; charset=utf-8 (review-queue-<date>.csv) or ' +
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
    const result = await this.exportQueue.execute(context, flagQuery(query));
    const log = (outcome: string): void =>
      this.#logger.log({
        msg: 'catalog.review-queue-export',
        outcome,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
    if (!result.ok) {
      const error = refusalWith(OFFER_REVIEW_STATUS, result.error, response, context);
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

  @Post('offers/:offerId/approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Publish an Offer that waits for its first publication',
    description:
      'Needs catalog.product.approve. Names the Offer version the reviewer saw. The description ' +
      'is claim-checked again; the seller must still be allowed to sell and the product must be ' +
      'published. Every certification tag of the Offer is asked again against the published ' +
      'revision: a tag no longer allowed is suspended and the Offer is published off sale; an ' +
      'unanswered check refuses (claim.check-unavailable); a lost race is retried, then ' +
      'conflict.retry.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'offerId', format: 'uuid' })
  @ApiBody({ type: OfferApproveRequest })
  @ApiOkResponse({ type: OfferDecided })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'offer.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'offer.not-pending-review, offer.product-not-published, seller.not-eligible, ' +
      'conflict.stale or conflict.retry',
  })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: 'claim-text.refused' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or claim.check-unavailable',
  })
  async approve(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('offerId') offerId: string,
    @Body() body: unknown,
  ): Promise<OfferDecided> {
    const input = closedBody(request, body, ['version']);
    let outcome: OfferDecided | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.approveOffer.execute(context, {
        offerId,
        version: input.version as number,
      });
      outcome = result.ok ? {} : refusalWith(OFFER_REVIEW_STATUS, result.error, response, context);
    }
    return this.settle('catalog.offer-approve', context, outcome);
  }

  @Post('offers/:offerId/request-changes')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Send an Offer back to the seller with a reason code',
    description:
      'Needs catalog.product.approve. Names the Offer version the reviewer saw and one reason ' +
      'code; the Offer becomes changes-needed and the seller is told by mail.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'offerId', format: 'uuid' })
  @ApiBody({ type: OfferRequestChangesRequest })
  @ApiOkResponse({ type: OfferDecided })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'offer.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'offer.not-pending-review or conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async requestOfferChanges(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('offerId') offerId: string,
    @Body() body: unknown,
  ): Promise<OfferDecided> {
    const input = closedBody(request, body, ['version', 'reasonCode']);
    let outcome: OfferDecided | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.requestChanges.execute(context, {
        offerId,
        version: input.version as number,
        reasonCode: input.reasonCode as string,
      });
      outcome = result.ok ? {} : refusalWith(OFFER_REVIEW_STATUS, result.error, response, context);
    }
    return this.settle('catalog.offer-request-changes', context, outcome);
  }

  @Get('offer-changes')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the held changes of live Offers that wait for a decision',
    description:
      'Needs catalog.product.view. Edits of published Offers the review policy held (slice 2c), ' +
      'as a super list (slice 5). Page read: `sort` (submitted), `direction` (asc default), ' +
      '`page`, `pageSize` (1 to 50) and `paging` (the Market "List paging" setting; `pages` ' +
      'gives `total`). Keyset read: `afterId` (the `nextAfterId` of the previous page) and ' +
      '`limit` (1 to 50, default 25), oldest first; never mixed with the page keys. Filters, all ' +
      'composable: `reasons` (comma-separated review reason codes; any of them), `sellerId`, ' +
      "`categoryId` (a platform category of the product's published revision), " +
      "`submittedFrom`/`submittedTo` (the age) and `q` (the review queue's search). Each row " +
      'carries the proposed fields, the reasons, the live values (`live`), the Offer now ' +
      "(`offer`), the product label, the store name and the caller's `actions`. `totalPending` " +
      'is the whole queue (the tab count).',
  })
  @ApiQuery({ name: 'afterId', required: false, description: 'The last change id of the page.' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 50, default 25.' })
  @ApiQuery({ name: 'sort', required: false, enum: ['submitted'] })
  @ApiQuery({ name: 'direction', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'page', required: false, description: 'Page number, 1 to 20.' })
  @ApiQuery({ name: 'pageSize', required: false, description: '1 to 50, default 25.' })
  @ApiQuery({
    name: 'paging',
    required: false,
    enum: ['pages', 'prev-next'],
    description: 'The Market "List paging" setting; `prev-next` gives no total.',
  })
  @ApiQuery({
    name: 'reasons',
    required: false,
    description: `Comma-separated review reasons, any of: ${OFFER_REVIEW_REASONS.join(', ')}.`,
  })
  @ApiQuery({ name: 'sellerId', required: false, description: "One seller's changes (uuid)." })
  @ApiQuery({
    name: 'categoryId',
    required: false,
    description: "A platform category of the product's published revision (uuid).",
  })
  @ApiQuery({
    name: 'submittedFrom',
    required: false,
    description: 'ISO 8601 instant with an offset or Z; submitted at or after it (inclusive).',
  })
  @ApiQuery({
    name: 'submittedTo',
    required: false,
    description:
      'ISO 8601 instant with an offset or Z; submitted before it (exclusive): "older than 24 h".',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'Search text, 2 to 100 characters after trimming: the product name (published, Market ' +
      'default locale), product code or seller public store name contains it, any case; % and _ ' +
      'are matched as typed.',
  })
  @ApiOkResponse({ type: OfferChangesListDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async changes(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<OfferChangesListDto> {
    const result = await this.listChanges.execute(context, numericQuery(pageQuery(query)));
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as OfferChangesListDto)
      : refusalWith(OFFER_REVIEW_STATUS, result.error, response, context);
    return this.settle('catalog.admin-offer-changes-list', context, outcome);
  }

  @Get('offer-changes/export')
  @ReadsSession()
  @ApiOperation({
    summary: 'Export the held changes of live Offers as a file',
    description:
      'Needs catalog.product.view. The rows of the Edits list for the same filters (`reasons`, ' +
      '`sellerId`, `categoryId`, `submittedFrom`, `submittedTo`, `q`), oldest submit first. ' +
      '`format` is csv (the default) or xlsx, with the columns change_id, offer_id, ' +
      'product_code, product_name, seller_id, store_name, seller_sku, fields, reasons, ' +
      'submitted_at (no free text). At most 1,000 rows; more is refused whole as ' +
      'batch.too-large; a `q` whose store names match more stores than can be searched is ' +
      'validation.failed (q, too-broad). An attachment. CSV: a text cell that starts with ' +
      '= + - @ gets a leading quote. XLSX: every cell is a string, never a formula.',
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'xlsx'] })
  @ApiQuery({ name: 'reasons', required: false })
  @ApiQuery({ name: 'sellerId', required: false })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'submittedFrom', required: false })
  @ApiQuery({ name: 'submittedTo', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiOkResponse({
    description:
      'text/csv; charset=utf-8 (offer-changes-<date>.csv) or ' +
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet (.xlsx), as an attachment',
  })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiPayloadTooLargeResponse({ type: ApiErrorBody, description: 'batch.too-large' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async downloadChanges(
    @Call() context: CallContext,
    @Res() response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.exportChanges.execute(context, query);
    const log = (outcome: string): void =>
      this.#logger.log({
        msg: 'catalog.admin-offer-changes-export',
        outcome,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
    if (!result.ok) {
      const error = refusalWith(OFFER_REVIEW_STATUS, result.error, response, context);
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

  @Get('offer-changes/:changeId')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Read one held change of a live Offer, with the live values',
    description:
      'Needs catalog.product.view. The change in any status, as a row of the list: proposed ' +
      'and live values (the Live | Proposed diff), the Offer now, product label, store name and ' +
      "the caller's actions. Another Market's change is offer-change.not-found.",
  })
  @ApiParam({ name: 'changeId', format: 'uuid' })
  @ApiOkResponse({ type: OfferChangeListItemDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'offer-change.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async change(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('changeId') changeId: string,
  ): Promise<OfferChangeListItemDto> {
    const result = await this.viewChange.execute(context, { changeId });
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as OfferChangeListItemDto)
      : refusalWith(OFFER_REVIEW_STATUS, result.error, response, context);
    return this.settle('catalog.admin-offer-change-view', context, outcome);
  }

  @Get('offer-review/stops')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Count the active Offer review stops (the admin stop banner)',
    description:
      "Needs catalog.product.view. Whether the Market's emergency stop is on, and how many " +
      'sellers and platform categories have their review stop on. Counts only. A part that ' +
      'cannot be read is null; the seller count is null without sellers.seller.view. `active` ' +
      'is true when any stop that could be read is on. For who and since of the Market stop, ' +
      'read settings/admin/offer-review/emergency-stop.',
  })
  @ApiOkResponse({ type: OfferReviewStopsDto })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  async stops(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OfferReviewStopsDto> {
    const result = await this.viewStops.execute(context, {});
    const outcome = result.ok
      ? { ...result.value }
      : refusalWith(OFFER_REVIEW_STATUS, result.error, response, context);
    return this.settle('catalog.offer-review-stops-view', context, outcome);
  }

  @Post('offer-changes/:changeId/approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Approve a held change of a live Offer',
    description:
      'Needs catalog.product.approve. The held fields go live in one step, all or nothing: the ' +
      'description is claim-checked again; the handling is set (an attestation is withdrawn off ' +
      'SEALED_ORIGINAL); every tag is asked of certification again and every requested type is ' +
      'asked afresh. One requested type not allowed fails the whole approval ' +
      '(claim.tag-not-allowed, details.tags) and the change stays pending. The body is optional: ' +
      'a note to the seller.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'changeId', format: 'uuid' })
  @ApiBody({ type: OfferChangeApproveRequest, required: false })
  @ApiOkResponse({ type: OfferChangeApprovedDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description:
      'access.denied, request.csrf or offer-change.own-submission (the decider submitted the ' +
      'change, or acts for its seller in a Login-as-Seller session)',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'offer-change.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'offer-change.not-pending, seller.not-eligible, conflict.stale or conflict.retry',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description:
      'claim-text.refused, claim.tag-not-allowed or offer-change.invalid (a held value the Offer ' +
      'refuses; nothing applied, the change stays pending)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'A body that is not JSON' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or claim.check-unavailable',
  })
  async approveOfferChange(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('changeId') changeId: string,
    @Body() body: unknown,
  ): Promise<OfferChangeApprovedDto> {
    const input = optionalClosedBody(request, body, ['note']);
    let outcome: OfferChangeApprovedDto | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.approveChange.execute(context, {
        changeId,
        ...(Object.hasOwn(input, 'note') ? { note: input.note } : {}),
      });
      outcome = result.ok
        ? { ...result.value, fields: [...result.value.fields] }
        : refusalWith(OFFER_REVIEW_STATUS, result.error, response, context);
    }
    return this.settle('catalog.admin-offer-change-approve', context, outcome);
  }

  @Post('offer-changes/:changeId/request-changes')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Send a held change of a live Offer back to the seller with a note',
    description:
      'Needs catalog.product.approve. The note (1 to 2000 characters) is shown to the seller; ' +
      'the live Offer stays as it is.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'changeId', format: 'uuid' })
  @ApiBody({ type: OfferChangeDecisionRequest })
  @ApiOkResponse({ type: OfferChangeDecidedDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description:
      'access.denied, request.csrf or offer-change.own-submission (the decider submitted the ' +
      'change, or acts for its seller in a Login-as-Seller session)',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'offer-change.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'offer-change.not-pending or conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async requestOfferChangeChanges(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('changeId') changeId: string,
    @Body() body: unknown,
  ): Promise<OfferChangeDecidedDto> {
    const input = closedBody(request, body, ['note']);
    let outcome: OfferChangeDecidedDto | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.requestChangeChanges.execute(context, {
        changeId,
        note: input.note,
      });
      outcome = result.ok
        ? { ...result.value }
        : refusalWith(OFFER_REVIEW_STATUS, result.error, response, context);
    }
    return this.settle('catalog.admin-offer-change-request-changes', context, outcome);
  }

  @Post('offer-changes/:changeId/reject')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Reject a held change of a live Offer with a note',
    description:
      'Needs catalog.product.approve. Terminal. The note (1 to 2000 characters) is shown to the ' +
      'seller; the live Offer stays as it is.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'changeId', format: 'uuid' })
  @ApiBody({ type: OfferChangeDecisionRequest })
  @ApiOkResponse({ type: OfferChangeDecidedDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description:
      'access.denied, request.csrf or offer-change.own-submission (the decider submitted the ' +
      'change, or acts for its seller in a Login-as-Seller session)',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'offer-change.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'offer-change.not-pending or conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async rejectOfferChange(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('changeId') changeId: string,
    @Body() body: unknown,
  ): Promise<OfferChangeDecidedDto> {
    const input = closedBody(request, body, ['note']);
    let outcome: OfferChangeDecidedDto | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.rejectChange.execute(context, { changeId, note: input.note });
      outcome = result.ok
        ? { ...result.value }
        : refusalWith(OFFER_REVIEW_STATUS, result.error, response, context);
    }
    return this.settle('catalog.admin-offer-change-reject', context, outcome);
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
