import {
  Body,
  Controller,
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
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
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
import { ProductRevisionApprove } from '../application/use-cases/product-revision-approve.use-case';
import { ProductRevisionRequestChanges } from '../application/use-cases/product-revision-request-changes.use-case';
import { closedBody, refusalWith } from './http-answers';
import {
  ProductRevisionApproveRequest,
  ProductRevisionDecided,
  ProductRevisionRequestChangesRequest,
} from './product-review.dto';
import { ApiErrorBody } from './platform-product.dto';

/**
 * The HTTP status of each refusal of the admin product revision review routes (catalog design 4.2,
 * 8.2, 8.3a). A malformed request is 400; an unknown or PLATFORM product is 404; a decision on a
 * state that has moved on (another revision pending, a stale version, a rebased product, a missing
 * check, a seller who may not sell) is 409; a claim in the texts or a variant limit is 422; a
 * missing dependency is 503.
 */
export const PRODUCT_REVIEW_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'product.not-found': 404,
  'review.not-current-revision': 409,
  'review.checks-missing': 409,
  'revision.base-changed': 409,
  'product.not-editable': 409,
  'seller.not-eligible': 409,
  'conflict.stale': 409,
  'variant.unknown': 409,
  'variant.none': 409,
  'variant.limit-reached': 422,
  'claim-text.refused': 422,
  'access.unavailable': 503,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/**
 * The review of a seller product's pending revision over HTTP (catalog design 4.2, 8.2): approve
 * it or send it back with a reason code. The queue itself is `GET /catalog/admin/review-queue`.
 * Admin routes read the admin session (`@ReadsSession`), so decisions need the CSRF token and the
 * admin panel's origin; JSON only, closed bodies. A thin adapter: one use case does the work
 * through its gate.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin')
export class ProductReviewController {
  readonly #logger = new Logger('ProductReviewController');

  constructor(
    private readonly approveRevision: ProductRevisionApprove,
    private readonly requestChanges: ProductRevisionRequestChanges,
  ) {}

  @Post('products/:productId/revisions/:revisionId/approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Publish the pending revision of a seller product',
    description:
      'Needs catalog.product.approve. Names the product version the reviewer saw and the named ' +
      'checks ticked; the queue row lists the required ones. The texts are claim-checked again ' +
      'and the seller must still be allowed to sell. The revision becomes the published one.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiParam({ name: 'revisionId', format: 'uuid' })
  @ApiBody({ type: ProductRevisionApproveRequest })
  @ApiOkResponse({ type: ProductRevisionDecided })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'product.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'conflict.stale, review.not-current-revision, review.checks-missing (details.issues), ' +
      'revision.base-changed, product.not-editable, seller.not-eligible or variant.*',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description: 'claim-text.refused or variant.limit-reached',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async approve(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') productId: string,
    @Param('revisionId') revisionId: string,
    @Body() body: unknown,
  ): Promise<ProductRevisionDecided> {
    const input = closedBody(request, body, ['version', 'checksConfirmed']);
    let outcome: ProductRevisionDecided | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.approveRevision.execute(context, {
        productId,
        revisionId,
        version: input.version as number,
        checksConfirmed: input.checksConfirmed as string[],
      });
      outcome = result.ok
        ? {}
        : refusalWith(PRODUCT_REVIEW_STATUS, result.error, response, context);
    }
    return this.settle('catalog.product-revision-approve', context, outcome);
  }

  @Post('products/:productId/revisions/:revisionId/request-changes')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Send the pending revision of a seller product back with a reason code',
    description:
      'Needs catalog.product.approve. Names the product version the reviewer saw and one reason ' +
      'code. The revision is closed; the seller sees the reason on their product and submits ' +
      'again from the working copy.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiParam({ name: 'revisionId', format: 'uuid' })
  @ApiBody({ type: ProductRevisionRequestChangesRequest })
  @ApiOkResponse({ type: ProductRevisionDecided })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'product.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'conflict.stale, review.not-current-revision or product.not-editable',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async requestRevisionChanges(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') productId: string,
    @Param('revisionId') revisionId: string,
    @Body() body: unknown,
  ): Promise<ProductRevisionDecided> {
    const input = closedBody(request, body, ['version', 'reasonCode']);
    let outcome: ProductRevisionDecided | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.requestChanges.execute(context, {
        productId,
        revisionId,
        version: input.version as number,
        reasonCode: input.reasonCode as string,
      });
      outcome = result.ok
        ? {}
        : refusalWith(PRODUCT_REVIEW_STATUS, result.error, response, context);
    }
    return this.settle('catalog.product-revision-request-changes', context, outcome);
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
