import { Controller, Get, Header, HttpException, Logger, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
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
import { OwnTopicList } from '../application/use-cases/own-topic-list.use-case';
import { pageQuery, refusalWith, type Refusal } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';
import { OwnTopicListBody } from './topic.dto';

/** The HTTP status of each refusal of the seller topic picker. */
export const OWN_TOPIC_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'access.unavailable': 503,
});

const refusal = (error: Refusal, response: Response, context?: CallContext): HttpException =>
  refusalWith(OWN_TOPIC_STATUS, error, response, context, 'catalog.own-topic-unmapped-refusal');

const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/**
 * The topics a seller may pick for a product (product tags T2): the active topics of the request's
 * Market, by slug, keyset-paged. A thin adapter over one use case (key
 * `catalog.own-product.edit`). Read-only, so no CSRF token.
 */
@ApiTags('catalog')
@RoutePopulation('seller')
@Controller('catalog/seller/topics')
export class OwnTopicController {
  readonly #logger = new Logger('OwnTopicController');

  constructor(private readonly listTopics: OwnTopicList) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the topics a product can carry',
    description:
      'Needs catalog.own-product.edit. Active topics only, by slug, keyset-paged: send ' +
      '`nextAfterId` of the previous page as `afterId`. `search` matches a name or synonym in ' +
      'any locale, or the slug. `limit` is 1 to 100 (default 25). A product carries at most ' +
      '`maxPerProduct` topics; a topic change always goes to review.',
  })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'afterId', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ type: OwnTopicListBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<OwnTopicListBody> {
    const result = await this.listTopics.execute(context, pageQuery(query));
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as OwnTopicListBody)
      : refusal(result.error, response, context);
    const failed = outcome instanceof HttpException && outcome.getStatus() >= 500;
    this.#logger[failed ? 'warn' : 'log']({
      msg: 'catalog.own-topic-list',
      outcome:
        outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
