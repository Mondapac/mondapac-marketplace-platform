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
import { AttributeRelaxationCancel } from '../application/use-cases/attribute-relaxation-cancel.use-case';
import { AttributeRelaxationConfirm } from '../application/use-cases/attribute-relaxation-confirm.use-case';
import { AttributeRelaxationListOpen } from '../application/use-cases/attribute-relaxation-list-open.use-case';
import { AttributeRelaxationRequestCreate } from '../application/use-cases/attribute-relaxation-request.use-case';
import { ATTRIBUTE_ADMIN_STATUS } from './attribute-admin.controller';
import {
  OpenRelaxationListBody,
  RelaxationConfirmBody,
  RelaxationRequestCreateRequest,
  RelaxationVersionRequest,
  RelaxationWriteWrapBody,
} from './attribute-admin.dto';
import { closedBody, refusalWith, type Refusal } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/**
 * The HTTP status of each refusal of the relaxation routes: the attribute routes' map, plus an
 * unknown request (404), the two-person refusals (403, as certification's
 * `review.second-admin-required`) and a request or attribute that moved on (409).
 */
export const RELAXATION_STATUS: Readonly<Record<string, number>> = Object.freeze({
  ...ATTRIBUTE_ADMIN_STATUS,
  'relaxation.not-found': 404,
  'relaxation.same-admin': 403,
  'relaxation.not-requester': 403,
  'relaxation.already-open': 409,
  'relaxation.stale': 409,
  'relaxation.closed': 409,
  'relaxation.expired': 409,
  'relaxation.attribute-changed': 409,
  'attribute-definition.not-material': 409,
});

const refusal = (error: Refusal, response: Response, context?: CallContext): HttpException =>
  refusalWith(RELAXATION_STATUS, error, response, context, 'catalog.attribute-relaxation-unmapped');

const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const EDITS = 'Needs catalog.attribute.edit (protected); refused in an acting-as session.';
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const REQUEST_PARAM = { name: 'requestId', description: 'The relaxation request. A UUID v7.' };

/**
 * The two-person request to clear `material` on a published attribute (catalog design 8.2;
 * attributes A2 part 3): one admin asks, a different admin confirms within 72 hours, and the
 * requester may withdraw it. Every route reads the admin session of the request's Market; the
 * list answers `no-store`; writes need the CSRF token, JSON and closed bodies. Thin adapters: each
 * route calls one use case through its gate (`catalog.attribute.edit`) and maps the answer to
 * `{ statusCode, code, details? }`, logging the outcome code with the correlation id.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin')
export class AttributeRelaxationController {
  readonly #logger = new Logger('AttributeRelaxationController');

  constructor(
    private readonly requestRelaxation: AttributeRelaxationRequestCreate,
    private readonly confirmRelaxation: AttributeRelaxationConfirm,
    private readonly cancelRelaxation: AttributeRelaxationCancel,
    private readonly listOpen: AttributeRelaxationListOpen,
  ) {}

  @Post('attributes/:attributeId/relaxation-requests')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Ask to turn off Material on a published attribute',
    description:
      `${EDITS} A different administrator must confirm within 72 hours; nothing changes until ` +
      'then. One open request per attribute.',
  })
  @ApiParam({ name: 'attributeId', description: 'The attribute. A UUID v7.' })
  @ApiHeader(CSRF)
  @ApiBody({ type: RelaxationRequestCreateRequest })
  @ApiCreatedResponse({ type: RelaxationWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'attribute.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'attribute.stale, relaxation.already-open, attribute-definition.not-material or .archived',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async request(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('attributeId') attributeId: string,
    @Body() body: unknown,
  ): Promise<RelaxationWriteWrapBody> {
    const input = closedBody(request, body, ['version', 'kind']);
    let outcome: RelaxationWriteWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.requestRelaxation.execute(context, { ...input, attributeId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as RelaxationWriteWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.attribute-relaxation-request', context, outcome);
  }

  @Post('attribute-relaxations/:requestId/confirm')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: "Confirm another administrator's request; Material is turned off at once",
    description:
      `${EDITS} Not the requester (relaxation.same-admin). Refused after 72 hours, for a ` +
      'request no longer open, and when the attribute changed since the request.',
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
      'relaxation.stale, relaxation.closed, relaxation.expired or relaxation.attribute-changed',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async confirm(
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
      const result = await this.confirmRelaxation.execute(context, { ...input, requestId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as RelaxationConfirmBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.attribute-relaxation-confirm', context, outcome);
  }

  @Post('attribute-relaxations/:requestId/cancel')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Withdraw your own request',
    description: `${EDITS} Only the requester (relaxation.not-requester), and only in time.`,
  })
  @ApiParam(REQUEST_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: RelaxationVersionRequest })
  @ApiOkResponse({ type: RelaxationWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, request.csrf or relaxation.not-requester',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'relaxation.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'relaxation.stale, relaxation.closed or relaxation.expired',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async cancel(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<RelaxationWriteWrapBody> {
    const input = closedBody(request, body, ['version']);
    let outcome: RelaxationWriteWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.cancelRelaxation.execute(context, { ...input, requestId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as RelaxationWriteWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.attribute-relaxation-cancel', context, outcome);
  }

  @Get('attribute-relaxations')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Requests waiting for a second administrator',
    description:
      `${EDITS} Open requests still in time, oldest first, each with what the reader may do: ` +
      "confirm another administrator's request, withdraw their own.",
  })
  @ApiOkResponse({ type: OpenRelaxationListBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OpenRelaxationListBody> {
    const result = await this.listOpen.execute(context, {});
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as OpenRelaxationListBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.attribute-relaxation-list-open', context, outcome);
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
