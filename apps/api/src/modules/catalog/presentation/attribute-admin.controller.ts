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
  Put,
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
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse,
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
import type { Request, Response } from 'express';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AttributeAdminGet } from '../application/use-cases/attribute-admin-get.use-case';
import { AttributeAdminList } from '../application/use-cases/attribute-admin-list.use-case';
import { FeatureSetAdminGet } from '../application/use-cases/feature-set-admin-get.use-case';
import { FeatureSetAdminList } from '../application/use-cases/feature-set-admin-list.use-case';
import { AttributeDefinitionCreate } from '../application/use-cases/attribute-definition-create.use-case';
import { AttributeDefinitionEdit } from '../application/use-cases/attribute-definition-edit.use-case';
import { AttributeDefinitionDiscard } from '../application/use-cases/attribute-definition-discard.use-case';
import { AttributeDefinitionPublish } from '../application/use-cases/attribute-definition-publish.use-case';
import {
  AttributeDetailBody,
  AttributeListBody,
  FeatureSetDetailBody,
  FeatureSetListBody,
  AttributeCreateRequest,
  AttributeEditRequest,
  AttributeVersionRequest,
  AttributeWriteWrapBody,
} from './attribute-admin.dto';
import { closedBody, pageQuery, refusalWith, type Refusal } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/**
 * The HTTP status of each refusal of the admin attribute routes (attributes plan, packages A1 and
 * A2). A malformed query or body is 400; an unknown or malformed id is 404; a taken code, a stale
 * version or a state that refuses the change is 409; content the rules refuse (a claim word, a
 * locale the claim check cannot read, a missing default name) is 422; a missing dependency or an
 * unreadable claim vocabulary is 503 (the save is refused, never let through).
 */
export const ATTRIBUTE_ADMIN_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'attribute-definition.code-invalid': 400,
  'attribute-definition.data-type-invalid': 400,
  'attribute-definition.locale-invalid': 400,
  'attribute.not-found': 404,
  'feature-set.not-found': 404,
  'attribute.code-taken': 409,
  'attribute.stale': 409,
  'attribute-definition.archived': 409,
  'attribute-definition.not-draft': 409,
  'attribute-definition.option-removed': 409,
  'attribute-definition.variant-locked': 409,
  'attribute-definition.material-relaxation-required': 409,
  'attribute.claim-word': 422,
  'attribute.locale-uncheckable': 422,
  'attribute-definition.name-required': 422,
  'attribute-definition.text-invalid': 422,
  'attribute-definition.bounds-invalid': 422,
  'attribute-definition.options-required': 422,
  'attribute-definition.options-not-allowed': 422,
  'attribute-definition.option-invalid': 422,
  'attribute-definition.option-repeated': 422,
  'attribute-definition.variant-option-needs-select': 422,
  'attribute-definition.options-too-many': 422,
  'attribute-definition.help-invalid': 422,
  'attribute-definition.note-invalid': 422,
  'attribute-definition.position-invalid': 422,
  'attribute-definition.default-name-required': 422,
  'attribute-definition.default-label-required': 422,
  'attribute-definition.active-option-required': 422,
  'access.unavailable': 503,
  'claim-text.check-unavailable': 503,
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
const EDITS = 'Needs catalog.attribute.edit (protected); refused in an acting-as session.';
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ATTRIBUTE_PARAM = { name: 'attributeId', description: 'The attribute. A UUID v7.' };
const WRITE_422 =
  'attribute.claim-word or attribute.locale-uncheckable (details.fields), or a content rule ' +
  '(attribute-definition.*, details.fields where it names a locale or a value)';

/** The content of an attribute a write may send (the use case reads and checks each one). */
const CONTENT_KEYS = [
  'names',
  'material',
  'isVariantOption',
  'bounds',
  'options',
  'helpText',
  'showOnProductPage',
  'searchable',
  'canBeFilter',
  'internalNote',
  'position',
] as const;
const CREATE_OPTIONAL = ['code', 'localizable', ...CONTENT_KEYS] as const;

/**
 * The attributes and feature sets (attribute families) of the request's Market over HTTP: the
 * reads of package A1 (the list with its filters, one attribute with its values, uses and history,
 * and the feature sets) and the attribute editor of package A2 (create a draft, save, publish,
 * discard). Every route reads the admin session of the request's Market (`@ReadsSession`); reads
 * answer `no-store`, writes need the CSRF token, JSON and closed bodies. Thin adapters: each route
 * calls one use case through its gate, which checks `catalog.attribute.view` (reads) or
 * `catalog.attribute.edit` (writes), and maps the answer to the error format
 * `{ statusCode, code, details? }`. Every route logs its outcome code with the correlation id;
 * never a body or a text.
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
    private readonly createAttribute: AttributeDefinitionCreate,
    private readonly editAttribute: AttributeDefinitionEdit,
    private readonly publishAttribute: AttributeDefinitionPublish,
    private readonly discardAttribute: AttributeDefinitionDiscard,
  ) {}

  @Post('attributes')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Create an attribute as a draft',
    description:
      `${EDITS} Sellers and buyers see nothing until it is published. The default-locale name ` +
      'is required; every name, help text and value label passes the claim-word check, and a ' +
      'language the check cannot read is refused.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: AttributeCreateRequest })
  @ApiCreatedResponse({ type: AttributeWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'attribute.code-taken' })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: WRITE_422 })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or claim-text.check-unavailable',
  })
  async create(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<AttributeWriteWrapBody> {
    const input = closedBody(request, body, ['dataType', 'names'], CREATE_OPTIONAL);
    let outcome: AttributeWriteWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.createAttribute.execute(context, input);
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as AttributeWriteWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.attribute-definition-create', context, outcome);
  }

  @Put('attributes/:attributeId')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Save an attribute',
    description:
      `${EDITS} The whole content and the version the admin saw (a later one is ` +
      'attribute.stale: reload). Saved as the next revision. Values are added, renamed, ' +
      'reordered or deactivated, never removed. Once published, the variant flag is fixed and ' +
      'clearing material needs the two-person request.',
  })
  @ApiParam(ATTRIBUTE_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AttributeEditRequest })
  @ApiOkResponse({ type: AttributeWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'attribute.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'attribute.stale, attribute-definition.archived, .option-removed (details.fields), ' +
      '.variant-locked or .material-relaxation-required',
  })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: WRITE_422 })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or claim-text.check-unavailable',
  })
  async edit(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('attributeId') attributeId: string,
    @Body() body: unknown,
  ): Promise<AttributeWriteWrapBody> {
    const input = closedBody(request, body, ['version', 'names'], CONTENT_KEYS);
    let outcome: AttributeWriteWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.editAttribute.execute(context, { ...input, attributeId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as AttributeWriteWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.attribute-definition-edit', context, outcome);
  }

  @Post('attributes/:attributeId/publish')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Publish a draft attribute',
    description:
      `${EDITS} Needs the default-locale name, and for a select type an active value labelled ` +
      'in the default locale. Other languages may still be missing.',
  })
  @ApiParam(ATTRIBUTE_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AttributeVersionRequest })
  @ApiOkResponse({ type: AttributeWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'attribute.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'attribute.stale or attribute-definition.not-draft',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description:
      'attribute-definition.default-name-required, .default-label-required (details.fields) ' +
      'or .active-option-required; attribute.claim-word or .locale-uncheckable (details.fields): ' +
      'the claim check runs again on publish',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or claim-text.check-unavailable',
  })
  async publish(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('attributeId') attributeId: string,
    @Body() body: unknown,
  ): Promise<AttributeWriteWrapBody> {
    return this.statusChange('catalog.attribute-definition-publish', this.publishAttribute, {
      context,
      request,
      response,
      attributeId,
      body,
    });
  }

  @Post('attributes/:attributeId/discard')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Discard a draft attribute',
    description:
      `${EDITS} Only a draft that was never published. It is archived, never deleted: its ` +
      'code stays taken and its history readable.',
  })
  @ApiParam(ATTRIBUTE_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AttributeVersionRequest })
  @ApiOkResponse({ type: AttributeWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'attribute.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'attribute.stale or attribute-definition.not-draft',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async discard(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('attributeId') attributeId: string,
    @Body() body: unknown,
  ): Promise<AttributeWriteWrapBody> {
    return this.statusChange('catalog.attribute-definition-discard', this.discardAttribute, {
      context,
      request,
      response,
      attributeId,
      body,
    });
  }

  private async statusChange(
    msg: string,
    useCase: AttributeDefinitionPublish | AttributeDefinitionDiscard,
    call: {
      readonly context: CallContext;
      readonly request: Request;
      readonly response: Response;
      readonly attributeId: string;
      readonly body: unknown;
    },
  ): Promise<AttributeWriteWrapBody> {
    const { context, request, response, attributeId, body } = call;
    const input = closedBody(request, body, ['version']);
    let outcome: AttributeWriteWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await useCase.execute(context, { ...input, attributeId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as AttributeWriteWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle(msg, context, outcome);
  }

  @Get('attributes')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List attributes',
    description:
      `${NEEDS} By code, keyset-paged: send \`nextAfterId\` of the previous page as ` +
      '`afterId`. `search` matches the code or a name in any locale; `type`, `status`, ' +
      '`usedIn` (a feature set id) and `missing` (a Market locale) filter. `limit` is 1 to 50 ' +
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
