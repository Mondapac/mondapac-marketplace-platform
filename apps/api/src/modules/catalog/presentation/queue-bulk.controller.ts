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
import { AttributeSuggestionBulkDecide } from '../application/use-cases/attribute-suggestion-bulk-decide.use-case';
import { CategoryProposalBulkDecide } from '../application/use-cases/category-proposal-bulk-decide.use-case';
import { ReviewQueueBulkDecide } from '../application/use-cases/review-queue-bulk-decide.use-case';
import { TopicSuggestionBulkDecide } from '../application/use-cases/topic-suggestion-bulk-decide.use-case';
import { VariantRequestBulkDecide } from '../application/use-cases/variant-request-bulk-decide.use-case';
import { closedBody, refusalWith, type Refusal } from './http-answers';
import { BulkDecideBody, BulkDecideRequest } from './queue-bulk.dto';
import { ApiErrorBody } from './platform-product.dto';

/** The HTTP status of each refusal of a bulk decision: only the request as a whole is refused. */
export const QUEUE_BULK_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'batch.too-large': 413,
  'access.denied': 403,
  'access.unavailable': 503,
});

const refusal = (error: Refusal, response: Response, context?: CallContext): HttpException =>
  refusalWith(QUEUE_BULK_STATUS, error, response, context, 'catalog.queue-bulk-unmapped-refusal');

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const BULK_NOTE =
  ' At most 50 rows; each goes through the queue’s own decision with the caller’s own keys, so a ' +
  'row that changed, was decided, or needs a key the caller lacks is skipped (`results`), never ' +
  'forced. The answer is 200 with counts even when every row was skipped.';

type Run = (
  input: Record<string, unknown>,
) => Promise<{ ok: true; value: object } | { ok: false; error: Refusal }>;

/**
 * The bulk accept and reject of the admin queues (super list: bulk actions): variant requests,
 * value suggestions, tag suggestions and category proposals. Thin adapters over one use case each;
 * writes need the CSRF token and the admin panel's origin, JSON only, closed bodies.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin')
export class QueueBulkController {
  readonly #logger = new Logger('QueueBulkController');

  constructor(
    private readonly variantRequests: VariantRequestBulkDecide,
    private readonly attributeSuggestions: AttributeSuggestionBulkDecide,
    private readonly topicSuggestions: TopicSuggestionBulkDecide,
    private readonly categoryProposals: CategoryProposalBulkDecide,
    private readonly reviewQueue: ReviewQueueBulkDecide,
  ) {}

  @Post('variant-requests/bulk-decide')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Approve or decline several variant requests',
    description: `Needs catalog.variant-request.review (an approve also catalog.platform-product.edit per row). \`action\` is \`approve\` or \`decline\` (with \`reason\`).${BULK_NOTE}`,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: BulkDecideRequest })
  @ApiOkResponse({ type: BulkDecideBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiPayloadTooLargeResponse({ type: ApiErrorBody, description: 'batch.too-large (max 50)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  variantRequestsDecide(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<BulkDecideBody> {
    return this.run(
      'catalog.variant-request-bulk-decide',
      context,
      response,
      request,
      body,
      ['action', 'items', 'reason'],
      (input) => this.variantRequests.execute(context, input),
    );
  }

  @Post('attribute-suggestions/bulk-decide')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Add or reject several suggested values',
    description: `Needs catalog.attribute-suggestion.decide. \`action\` is \`approve\` (each value is added as the seller wrote it, in the default locale) or \`reject\` (with \`reason\`).${BULK_NOTE}`,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: BulkDecideRequest })
  @ApiOkResponse({ type: BulkDecideBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiPayloadTooLargeResponse({ type: ApiErrorBody, description: 'batch.too-large (max 50)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  attributeSuggestionsDecide(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<BulkDecideBody> {
    return this.run(
      'catalog.attribute-suggestion-bulk-decide',
      context,
      response,
      request,
      body,
      ['action', 'items', 'reason'],
      (input) => this.attributeSuggestions.execute(context, input),
    );
  }

  @Post('topic-suggestions/bulk-decide')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Create tags from, or reject, several tag suggestions',
    description: `Needs catalog.topic-suggestion.review (an approve also catalog.topic.manage per row). \`action\` is \`approve\` (with \`group\`; each tag is named as the seller wrote it) or \`reject\` (with \`reason\`).${BULK_NOTE}`,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: BulkDecideRequest })
  @ApiOkResponse({ type: BulkDecideBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiPayloadTooLargeResponse({ type: ApiErrorBody, description: 'batch.too-large (max 50)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  topicSuggestionsDecide(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<BulkDecideBody> {
    return this.run(
      'catalog.topic-suggestion-bulk-decide',
      context,
      response,
      request,
      body,
      ['action', 'items'],
      (input) => this.topicSuggestions.execute(context, input),
      ['reason', 'group'],
    );
  }

  @Post('category-proposals/bulk-decide')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Approve or reject several category proposals',
    description: `Needs catalog.category-proposal.decide. \`action\` is \`approve\` or \`reject\` (with \`reasonCode\`).${BULK_NOTE}`,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: BulkDecideRequest })
  @ApiOkResponse({ type: BulkDecideBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiPayloadTooLargeResponse({ type: ApiErrorBody, description: 'batch.too-large (max 50)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  categoryProposalsDecide(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<BulkDecideBody> {
    return this.run(
      'catalog.category-proposal-bulk-decide',
      context,
      response,
      request,
      body,
      ['action', 'items'],
      (input) => this.categoryProposals.execute(context, input),
      ['reasonCode'],
    );
  }

  @Post('review-queue/bulk-decide')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Approve or send back several rows of the review queue',
    description:
      'Needs catalog.product.approve. `kind` is `revision` (items `{ id: productId, revisionId, version }`) or `offer` (items `{ id: offerId, version }`). `action` is `approve` or `request-changes` (with `reasonCode`). ' +
      'A bulk approve never ticks a manual check: a revision whose review needs checks is skipped with `review.checks-missing` and must be opened and decided one by one.' +
      BULK_NOTE,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: BulkDecideRequest })
  @ApiOkResponse({ type: BulkDecideBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiPayloadTooLargeResponse({ type: ApiErrorBody, description: 'batch.too-large (max 50)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  reviewQueueDecide(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<BulkDecideBody> {
    return this.run(
      'catalog.review-queue-bulk-decide',
      context,
      response,
      request,
      body,
      ['action', 'items'],
      (input) => this.reviewQueue.execute(context, input),
      ['kind', 'reasonCode'],
    );
  }

  private async run(
    msg: string,
    context: CallContext,
    response: Response,
    request: Request,
    body: unknown,
    keys: readonly string[],
    run: Run,
    optional: readonly string[] = [],
  ): Promise<BulkDecideBody> {
    const input = closedBody(
      request,
      body,
      ['action', 'items'],
      [...keys.filter((k) => k !== 'action' && k !== 'items'), ...optional],
    );
    let outcome: BulkDecideBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await run(input);
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as BulkDecideBody)
        : refusal(result.error, response, context);
    }
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
