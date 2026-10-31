import { Body, Controller, HttpCode, HttpException, Logger, Post, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOperation,
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
import { OwnBrandPropose } from '../application/use-cases/own-brand-propose.use-case';
import { BrandProposeRequest, BrandProposedBody } from './brand.dto';
import { closedBody, refusalWith } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/**
 * The HTTP status of each refusal of the seller brand route (catalog brand package). A malformed
 * request is 400; a seller who may not sell, or who has no own-brand product, is 403; a taken look-alike
 * or slug is 409; a seller with too many proposals waiting is 422; a missing dependency is 503.
 */
export const OWN_BRAND_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'brand.slug-invalid': 400,
  'seller.not-eligible': 403,
  'brand.own-brand-required': 403,
  'brand.slug-taken': 409,
  'brand.near-duplicate': 409,
  'brand.proposal-limit': 422,
  'access.unavailable': 503,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/**
 * Seller brand proposals over HTTP (catalog brand package): a seller who sells an own-brand
 * product proposes the brand. The seller session of the request's Market is read
 * (`@ReadsSession`), so the route needs the CSRF token and the seller panel's origin; JSON only, a
 * closed body. A thin adapter over one use case (key `catalog.own-product.edit`).
 */
@ApiTags('catalog')
@RoutePopulation('seller')
@Controller('catalog/seller/brands')
export class OwnBrandController {
  readonly #logger = new Logger('OwnBrandController');

  constructor(private readonly propose: OwnBrandPropose) {}

  @Post()
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Propose a brand',
    description:
      'Needs catalog.own-product.edit and a seller who may sell. Allowed only when the seller ' +
      'has at least one product marked as their own brand. The brand is created as a draft with ' +
      'the seller as proposer: it has no public page and no product resolves to it until an admin ' +
      'approves it. A name that is a near-duplicate of a live brand is refused with that brand ' +
      '(details.brands); at most 5 proposals may wait at once.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: BrandProposeRequest })
  @ApiCreatedResponse({ type: BrandProposedBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description:
      'access.denied, request.csrf, access.seller-not-approved, seller.not-eligible or brand.own-brand-required',
  })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'brand.near-duplicate (details.brands) or brand.slug-taken',
  })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: 'brand.proposal-limit' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async create(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<BrandProposedBody> {
    const input = closedBody(request, body, ['name'], ['summary', 'originCountry']);
    let outcome: BrandProposedBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.propose.execute(context, input);
      outcome = result.ok
        ? { ...result.value }
        : refusalWith(
            OWN_BRAND_STATUS,
            result.error,
            response,
            context,
            'catalog.own-brand-unmapped-refusal',
          );
    }
    const failed = outcome instanceof HttpException && outcome.getStatus() >= 500;
    this.#logger[failed ? 'warn' : 'log']({
      msg: 'catalog.own-brand-propose',
      outcome:
        outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
