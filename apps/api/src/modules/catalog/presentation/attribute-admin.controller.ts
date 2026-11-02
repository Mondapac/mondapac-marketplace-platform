import { Controller, Get, Header, HttpException, Logger, Param, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ATTRIBUTE_DATA_TYPES } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AttributeAdminGet } from '../application/use-cases/attribute-admin-get.use-case';
import { AttributeAdminList } from '../application/use-cases/attribute-admin-list.use-case';
import { FeatureSetAdminGet } from '../application/use-cases/feature-set-admin-get.use-case';
import { FeatureSetAdminList } from '../application/use-cases/feature-set-admin-list.use-case';
import {
  AttributeDetailBody,
  AttributeListBody,
  FeatureSetDetailBody,
  FeatureSetListBody,
} from './attribute-admin.dto';
import { pageQuery, refusalWith, type Refusal } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/**
 * The HTTP status of each refusal of the admin attribute reads (attributes plan, package A1). A
 * malformed query is 400; an unknown or malformed id is 404; a missing dependency is 503.
 */
export const ATTRIBUTE_ADMIN_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'attribute.not-found': 404,
  'feature-set.not-found': 404,
  'access.unavailable': 503,
});

const refusal = (error: Refusal, response: Response, context?: CallContext): HttpException =>
  refusalWith(
    ATTRIBUTE_ADMIN_STATUS,
    error,
    response,
    context,
    'catalog.attribute-admin-unmapped-refusal',
  );

const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const NEEDS = 'Needs catalog.attribute.view.';

/**
 * The attributes and feature sets (attribute families) of the request's Market over HTTP, read
 * only (attributes plan, package A1): the list with its filters, one attribute with its values,
 * uses and history, and the feature sets. Every route reads the admin session of the request's
 * Market (`@ReadsSession`) and answers `no-store`. Thin adapters: each route calls one use case
 * through its gate, which checks `catalog.attribute.view`, and maps the answer to the error format
 * `{ statusCode, code, details? }`. Every route logs its outcome code with the correlation id.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin')
export class AttributeAdminController {
  readonly #logger = new Logger('AttributeAdminController');

  constructor(
    private readonly listAttributes: AttributeAdminList,
    private readonly getAttribute: AttributeAdminGet,
    private readonly listFeatureSets: FeatureSetAdminList,
    private readonly getFeatureSet: FeatureSetAdminGet,
  ) {}

  @Get('attributes')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List attributes',
    description:
      `${NEEDS} By code, keyset-paged: send \`nextAfterId\` of the previous page as ` +
      '`afterId`. `search` matches the code or a name in any locale; `type`, `status`, ' +
      '`usedIn` (a feature set id) and `missing` (a Market locale) filter. `limit` is 1 to 100 ' +
      '(default 25).',
  })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'type', required: false, enum: ATTRIBUTE_DATA_TYPES })
  @ApiQuery({ name: 'status', required: false, enum: ['draft', 'active', 'archived'] })
  @ApiQuery({ name: 'usedIn', required: false, description: 'A feature set id.' })
  @ApiQuery({ name: 'missing', required: false, description: 'A locale of the Market.' })
  @ApiQuery({ name: 'afterId', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ type: AttributeListBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<AttributeListBody> {
    const result = await this.listAttributes.execute(context, pageQuery(query));
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as AttributeListBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.attribute-admin-list', context, outcome);
  }

  @Get('attributes/:attributeId')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Read an attribute',
    description:
      `${NEEDS} The current revision, the values with their product counts, the feature sets ` +
      'and groups that use it, and the newest 100 revisions with their field-by-field changes.',
  })
  @ApiParam({ name: 'attributeId', description: 'The attribute. A UUID v7.' })
  @ApiOkResponse({ type: AttributeDetailBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'attribute.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async read(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('attributeId') attributeId: string,
  ): Promise<AttributeDetailBody> {
    const result = await this.getAttribute.execute(context, { attributeId });
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as AttributeDetailBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.attribute-admin-get', context, outcome);
  }

  @Get('feature-sets')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List feature sets',
    description: `${NEEDS} Every feature set (attribute family) of the Market, by code, with counts.`,
  })
  @ApiOkResponse({ type: FeatureSetListBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async featureSets(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<FeatureSetListBody> {
    const result = await this.listFeatureSets.execute(context, query as Record<string, never>);
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as FeatureSetListBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.feature-set-admin-list', context, outcome);
  }

  @Get('feature-sets/:featureSetId')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Read a feature set',
    description: `${NEEDS} The groups in order, each attribute with its required and variant flags.`,
  })
  @ApiParam({ name: 'featureSetId', description: 'The feature set. A UUID v7.' })
  @ApiOkResponse({ type: FeatureSetDetailBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'feature-set.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async featureSet(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('featureSetId') featureSetId: string,
  ): Promise<FeatureSetDetailBody> {
    const result = await this.getFeatureSet.execute(context, { featureSetId });
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as FeatureSetDetailBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.feature-set-admin-get', context, outcome);
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
