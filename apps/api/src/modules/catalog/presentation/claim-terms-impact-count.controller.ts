import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpException,
  Logger,
  Post,
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
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ClaimTermsImpactCount } from '../application/use-cases/claim-terms-impact-count.use-case';
import {
  ClaimTermsImpactCountBody,
  ClaimTermsImpactCountRequest,
} from './claim-terms-impact-count.dto';
import { refusalWith } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/** The HTTP status of each refusal of the count. */
export const CLAIM_TERMS_IMPACT_COUNT_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'access.denied': 403,
  'request.throttled': 429,
  'access.unavailable': 503,
  'claim-text.check-unavailable': 503,
});

const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/**
 * `claim-terms.impact-count` (catalog design 6.5, request C-7): the admin "New certificate type"
 * and edit dialogs ask how many published texts a proposed term list would match. A thin adapter
 * over one use case; read-only, though a POST because the terms travel in the body.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/claim-terms')
export class ClaimTermsImpactCountController {
  readonly #logger = new Logger('ClaimTermsImpactCountController');

  constructor(private readonly count: ClaimTermsImpactCount) {}

  @Post('impact-count')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Count the published texts a proposed claim term list would match',
    description:
      'Needs certification.type.edit; refused in an acting-as session. Scans the published ' +
      'products (name, short description, description, every locale) and published Offer ' +
      'descriptions of the Market against the proposed terms of every locale, at most 20,000 ' +
      'texts or 10 seconds: past that it answers complete=false and the numbers are "at ' +
      'least". Not yet counted: category names and descriptions, attribute definition names ' +
      'and option labels, category proposals. Read-only; nothing is stored or flagged. ' +
      'claim-text.check-unavailable (503): show "We couldn\'t count the affected products"; ' +
      "never read it as zero. Spends the account's claim-text check budget (30 a minute).",
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: ClaimTermsImpactCountRequest })
  @ApiOkResponse({ type: ClaimTermsImpactCountBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'request.throttled (details.retryAfterSeconds)',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or claim-text.check-unavailable',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async post(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<ClaimTermsImpactCountBody> {
    const result = await this.count.execute(context, { body });
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as ClaimTermsImpactCountBody)
      : refusalWith(CLAIM_TERMS_IMPACT_COUNT_STATUS, result.error, response, context);
    const failed =
      !result.ok &&
      (result.error.code === 'access.unavailable' ||
        result.error.code === 'claim-text.check-unavailable');
    this.#logger[failed ? 'warn' : 'log']({
      msg: 'catalog.claim-terms-impact-count',
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
