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
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
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
import { OwnAttributeValueSuggest } from '../application/use-cases/own-attribute-value-suggest.use-case';
import { OwnAttributeSuggestionsList } from '../application/use-cases/own-attribute-suggestions-list.use-case';
import {
  OwnSuggestionListBody,
  SuggestionOpenedBody,
  SuggestValueRequest,
} from './attribute-suggestion.dto';
import { closedBody, pageQuery, refusalWith } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/** The HTTP status of each refusal of the seller suggestion route (attributes A5). */
export const OWN_SUGGESTION_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'seller.not-eligible': 403,
  'product.not-found': 404,
  'product.not-editable': 409,
  'suggestion.value-exists': 409,
  'suggestion.already-open': 409,
  'suggestion.label-invalid': 422,
  'suggestion.limit-reached': 422,
  'attribute.not-suggestable': 422,
  'access.unavailable': 503,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/**
 * A seller's request for a value a select field does not offer (attributes plan, package A5).
 * The seller session of the request's Market is read, so the route needs the CSRF token and the
 * seller panel's origin; JSON only, a closed body. A thin adapter over one use case (key
 * `catalog.own-product.edit`).
 */
@ApiTags('catalog')
@RoutePopulation('seller')
@Controller('catalog/seller/products')
export class OwnAttributeSuggestionController {
  readonly #logger = new Logger('OwnAttributeSuggestionController');

  constructor(private readonly suggest: OwnAttributeValueSuggest) {}

  @Post(':productId/attribute-suggestions')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Suggest a value for a select field',
    description:
      'Needs catalog.own-product.edit and a seller who may sell. Only a select or multi-select ' +
      'field that is not Material and not a variant option takes a suggestion. One open ' +
      'suggestion per product and field, at most 10 open per seller. The product keeps the ' +
      'field empty until an admin decides; a required field then holds back the submit ' +
      '(attribute.suggestion-pending). The seller is told the outcome by mail.',
  })
  @ApiParam({ name: 'productId', description: 'The seller’s own product. A UUID v7.' })
  @ApiHeader(CSRF)
  @ApiBody({ type: SuggestValueRequest })
  @ApiCreatedResponse({ type: SuggestionOpenedBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, request.csrf, access.seller-not-approved or seller.not-eligible',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'product.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'product.not-editable, suggestion.already-open or suggestion.value-exists',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description:
      'suggestion.label-invalid, suggestion.limit-reached (details.max) or attribute.not-suggestable',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async create(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('productId') productId: string,
    @Body() body: unknown,
  ): Promise<SuggestionOpenedBody> {
    const input = closedBody(request, body, ['attributeCode', 'label']);
    let outcome: SuggestionOpenedBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.suggest.execute(context, {
        productId,
        attributeCode: input['attributeCode'],
        label: input['label'],
      });
      outcome = result.ok
        ? { ...result.value }
        : refusalWith(
            OWN_SUGGESTION_STATUS,
            result.error,
            response,
            context,
            'catalog.own-attribute-suggestion-unmapped-refusal',
          );
    }
    const failed = outcome instanceof HttpException && outcome.getStatus() >= 500;
    this.#logger[failed ? 'warn' : 'log']({
      msg: 'catalog.own-attribute-value-suggest',
      outcome:
        outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}

/**
 * The seller's own value suggestions over HTTP (the seller panel's "Value suggestions" page): one
 * read of every suggestion the seller made, with its outcome. The seller session of the request's
 * Market is read, so the route needs the seller panel's origin. A thin adapter over one use case
 * (key `catalog.own-product.view`).
 */
@ApiTags('catalog')
@RoutePopulation('seller')
@Controller('catalog/seller/attribute-suggestions')
export class OwnAttributeSuggestionsController {
  readonly #logger = new Logger('OwnAttributeSuggestionsController');

  constructor(private readonly listSuggestions: OwnAttributeSuggestionsList) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: "List the seller's value suggestions",
    description:
      'Needs catalog.own-product.view. Newest first, keyset-paged: send `nextAfterId` of the ' +
      'previous page as `afterId`. `limit` is 1 to 50 (default 25); `status` narrows to open, ' +
      'approved, mapped or rejected. `openCount` and `maxOpen` count the waiting ones whatever ' +
      'the filter. Only the seller’s own suggestions are read.',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['open', 'approved', 'mapped', 'rejected'] })
  @ApiQuery({ name: 'afterId', required: false, description: 'The last id of the previous page.' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 50, default 25.' })
  @ApiOkResponse({ type: OwnSuggestionListBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<OwnSuggestionListBody> {
    const result = await this.listSuggestions.execute(context, pageQuery(query));
    const outcome: OwnSuggestionListBody | HttpException = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as OwnSuggestionListBody)
      : refusalWith(
          OWN_SUGGESTION_STATUS,
          result.error,
          response,
          context,
          'catalog.own-attribute-suggestions-unmapped-refusal',
        );
    const failed = outcome instanceof HttpException && outcome.getStatus() >= 500;
    this.#logger[failed ? 'warn' : 'log']({
      msg: 'catalog.own-attribute-suggestions-list',
      outcome:
        outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
