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
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AttributeArchive } from '../application/use-cases/attribute-archive.use-case';
import { AttributeArchiveConfirm } from '../application/use-cases/attribute-archive-confirm.use-case';
import { AttributeArchiveRequestCreate } from '../application/use-cases/attribute-archive-request.use-case';
import { AttributeArchiveRequestListOpen } from '../application/use-cases/attribute-archive-request-list-open.use-case';
import { AttributeConvert } from '../application/use-cases/attribute-convert.use-case';
import { AttributeMerge } from '../application/use-cases/attribute-merge.use-case';
import { AttributeImpactGet } from '../application/use-cases/attribute-impact-get.use-case';
import { AttributeValuesMerge } from '../application/use-cases/attribute-values-merge.use-case';
import {
  AttributeImpactBody,
  AttributeVersionRequest,
  AttributeWriteWrapBody,
  OpenRelaxationListBody,
  RelaxationConfirmBody,
  RelaxationVersionRequest,
  RelaxationWriteWrapBody,
  AttributeConvertRequest,
  AttributeMergeRequest,
  ValuesMergeRequest,
} from './attribute-admin.dto';
import { RELAXATION_STATUS } from './attribute-relaxation.controller';
import { closedBody, refusalWith, type Refusal } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/**
 * The HTTP status of each refusal of the restructure routes (attributes A8): the relaxation
 * routes' map, plus the merge and archive refusals. An attribute that cannot be archived now (an
 * active feature set, live variants, `material` without a second admin) or values that cannot be
 * merged are 409 or 422 like the other state refusals.
 */
export const RESTRUCTURE_STATUS: Readonly<Record<string, number>> = Object.freeze({
  ...RELAXATION_STATUS,
  'attribute-definition.not-published': 409,
  'attribute-definition.not-select': 422,
  'attribute-definition.merge-invalid': 422,
  'attribute-definition.merge-type-mismatch': 422,
  'attribute-definition.merge-unmapped': 422,
  'attribute-definition.merge-material': 409,
  'attribute-definition.convert-invalid': 422,
  'attribute-definition.convert-variant': 409,
  'attribute-definition.convert-material': 409,
  'attribute-definition.convert-merged': 409,
  'attribute.merge-blocked': 409,
  'attribute.archive-blocked': 409,
  'attribute.archive-needs-second-admin': 409,
  'attribute.archive-not-material': 409,
});

const refusal = (error: Refusal, response: Response, context?: CallContext): HttpException =>
  refusalWith(
    RESTRUCTURE_STATUS,
    error,
    response,
    context,
    'catalog.attribute-restructure-unmapped',
  );

const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const RESTRUCTURES =
  'Needs catalog.attribute.restructure (protected); refused in an acting-as session.';
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ATTRIBUTE_PARAM = { name: 'attributeId', description: 'The attribute. A UUID v7.' };
const REQUEST_PARAM = { name: 'requestId', description: 'The archive request. A UUID v7.' };

/**
 * The changes that reach every product using an attribute (attributes A8): the impact dialog's
 * read, merging values and archiving, with the two-person request for a `material` attribute.
 * Every route reads the admin session of the request's Market; the read answers `no-store`;
 * writes need the CSRF token, JSON and closed bodies. Thin adapters: each route calls one use case
 * through its gate (`catalog.attribute.restructure`) and maps the answer to
 * `{ statusCode, code, details? }`, logging the outcome code with the correlation id.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin')
export class AttributeRestructureController {
  readonly #logger = new Logger('AttributeRestructureController');

  constructor(
    private readonly impact: AttributeImpactGet,
    private readonly mergeValues: AttributeValuesMerge,
    private readonly mergeAttribute: AttributeMerge,
    private readonly convertAttribute: AttributeConvert,
    private readonly archive: AttributeArchive,
    private readonly requestArchive: AttributeArchiveRequestCreate,
    private readonly confirmArchive: AttributeArchiveConfirm,
    private readonly listArchiveRequests: AttributeArchiveRequestListOpen,
  ) {}

  @Get('attributes/:attributeId/impact')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'What changing this attribute would reach',
    description:
      `${RESTRUCTURES} Published products, drafts, active feature sets, categories, filters ` +
      'and variants; a count that stops at its cap says atLeast.',
  })
  @ApiParam(ATTRIBUTE_PARAM)
  @ApiOkResponse({ type: AttributeImpactBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'attribute.not-found' })
  async getImpact(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('attributeId') attributeId: string,
  ): Promise<AttributeImpactBody> {
    const result = await this.impact.execute(context, { attributeId });
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as AttributeImpactBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.attribute-impact-get', context, outcome);
  }

  @Post('attributes/:attributeId/merge-values')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Merge one value of a select attribute into another',
    description:
      `${RESTRUCTURES} The source value stays, inactive and "merged into" the target. Products ` +
      'are not changed; the storefront reads the target for the source.',
  })
  @ApiParam(ATTRIBUTE_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: ValuesMergeRequest })
  @ApiOkResponse({ type: AttributeWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'attribute.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'attribute.stale, attribute-definition.not-published or attribute-definition.archived',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async merge(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('attributeId') attributeId: string,
    @Body() body: unknown,
  ): Promise<AttributeWriteWrapBody> {
    const input = closedBody(request, body, ['version', 'source', 'target']);
    let outcome: AttributeWriteWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.mergeValues.execute(context, { ...input, attributeId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as AttributeWriteWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.attribute-values-merge', context, outcome);
  }

  @Post('attributes/:attributeId/merge')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Merge an attribute into another of the same type',
    description:
      `${RESTRUCTURES} The source is archived and points at the target; its values are mapped to ` +
      'target values. Products are not changed; the storefront reads the target for the source. ' +
      'Refused for a material source, for a source still in an active feature set and for ' +
      'live variants.',
  })
  @ApiParam(ATTRIBUTE_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AttributeMergeRequest })
  @ApiOkResponse({ type: AttributeWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'attribute.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'attribute.stale, attribute.merge-blocked (details.fields[0].code in-feature-set or ' +
      'live-variants), attribute-definition.merge-invalid, .merge-type-mismatch, ' +
      '.merge-unmapped, .merge-material, .not-published or .archived',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async mergeInto(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('attributeId') attributeId: string,
    @Body() body: unknown,
  ): Promise<AttributeWriteWrapBody> {
    const input = closedBody(request, body, ['version', 'target', 'targetVersion', 'options']);
    let outcome: AttributeWriteWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.mergeAttribute.execute(context, { ...input, attributeId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as AttributeWriteWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.attribute-merge', context, outcome);
  }

  @Post('attributes/:attributeId/convert')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Convert the type of a published attribute',
    description:
      `${RESTRUCTURES} Two paths only: integer to decimal and select to multi-select. Stored ` +
      'product values are not changed; they are read as the new type. Refused for a material ' +
      'attribute, a variant option and an attribute others were merged into.',
  })
  @ApiParam(ATTRIBUTE_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AttributeConvertRequest })
  @ApiOkResponse({ type: AttributeWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'attribute.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'attribute.stale, attribute-definition.convert-variant, .convert-material, ' +
      '.convert-merged, .not-published or .archived',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async convert(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('attributeId') attributeId: string,
    @Body() body: unknown,
  ): Promise<AttributeWriteWrapBody> {
    const input = closedBody(request, body, ['version', 'to']);
    let outcome: AttributeWriteWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.convertAttribute.execute(context, { ...input, attributeId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as AttributeWriteWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.attribute-convert', context, outcome);
  }

  @Post('attributes/:attributeId/archive')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Archive a published attribute that is not material',
    description:
      `${RESTRUCTURES} Refused while an active feature set lists it or live variants use it. ` +
      'A material attribute is archived by a request and a second administrator instead.',
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
    description:
      'attribute.stale, attribute.archive-blocked (details.fields[0].code in-feature-set or ' +
      'live-variants), attribute.archive-needs-second-admin, attribute-definition.not-published ' +
      'or attribute-definition.archived',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async archiveAttribute(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('attributeId') attributeId: string,
    @Body() body: unknown,
  ): Promise<AttributeWriteWrapBody> {
    const input = closedBody(request, body, ['version']);
    let outcome: AttributeWriteWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.archive.execute(context, { ...input, attributeId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as AttributeWriteWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.attribute-archive', context, outcome);
  }

  @Post('attributes/:attributeId/archive-requests')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Ask to archive a material attribute',
    description:
      `${RESTRUCTURES} A different administrator with the same key must confirm within 72 ` +
      'hours; nothing changes until then. One open request per attribute.',
  })
  @ApiParam(ATTRIBUTE_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AttributeVersionRequest })
  @ApiCreatedResponse({ type: RelaxationWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'attribute.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'attribute.stale, relaxation.already-open, attribute.archive-blocked or ' +
      'attribute.archive-not-material',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async requestArchiveOf(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('attributeId') attributeId: string,
    @Body() body: unknown,
  ): Promise<RelaxationWriteWrapBody> {
    const input = closedBody(request, body, ['version']);
    let outcome: RelaxationWriteWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.requestArchive.execute(context, { ...input, attributeId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as RelaxationWriteWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.attribute-archive-request', context, outcome);
  }

  @Get('attribute-archive-requests')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Archive requests waiting for a second administrator',
    description:
      `${RESTRUCTURES} Open archive requests still in time, oldest first, each with what the ` +
      "reader may do: confirm another administrator's request, withdraw their own.",
  })
  @ApiOkResponse({ type: OpenRelaxationListBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  async listArchive(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OpenRelaxationListBody> {
    const result = await this.listArchiveRequests.execute(context, {});
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as OpenRelaxationListBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.attribute-archive-request-list-open', context, outcome);
  }

  @Post('attribute-archive-requests/:requestId/confirm')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: "Confirm another administrator's archive request; the attribute is archived at once",
    description:
      `${RESTRUCTURES} Not the requester (relaxation.same-admin). Refused after 72 hours, for a ` +
      'request no longer open, when the attribute changed since the request, and when it can ' +
      'no longer be archived.',
  })
  @ApiParam(REQUEST_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: RelaxationVersionRequest })
  @ApiOkResponse({ type: RelaxationConfirmBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, request.csrf or relaxation.same-admin',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'relaxation.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'relaxation.stale, .closed, .expired, .attribute-changed or attribute.archive-blocked',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async confirmArchiveOf(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<RelaxationConfirmBody> {
    const input = closedBody(request, body, ['version']);
    let outcome: RelaxationConfirmBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.confirmArchive.execute(context, { ...input, requestId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as RelaxationConfirmBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.attribute-archive-confirm', context, outcome);
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
