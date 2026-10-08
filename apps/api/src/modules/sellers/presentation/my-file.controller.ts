import { Body, Controller, Get, HttpCode, Logger, Post, Put, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import { SessionPopulation } from '../../../platform/call-context/session-population.decorator';
import { FormDescriptorsRead } from '../application/use-cases/form-descriptors-read.use-case';
import { MyFileCheckSlug } from '../application/use-cases/my-file-check-slug.use-case';
import { MyFileRead } from '../application/use-cases/my-file-read.use-case';
import { MyFileSaveAddress } from '../application/use-cases/my-file-save-address.use-case';
import { MyFileSaveGeneral } from '../application/use-cases/my-file-save-general.use-case';
import { errorOf, fail, type MyFileError } from './my-file.answer';
import {
  parseAddressBody,
  parseGeneralBody,
  parseSlugBody,
  type FieldProblem,
} from './my-file.body';
import {
  AddressSavedBody,
  CheckSlugRequest,
  DraftSavedBody,
  FormDescriptorsBody,
  MyFileBody,
  SaveAddressRequest,
  SaveGeneralRequest,
  SellersErrorBody,
  SlugCheckBody,
} from './my-file.dto';

// Shape is checked before the gate: a malformed body answers 400 to any signed-in caller. That
// reveals only the published schema (OpenAPI); identity does the same.
const NO_STORE = 'no-store';

/**
 * The seller's own draft over HTTP (sellers design 6.2, 8.3; SEL-11, SEL-22; slice 2). Thin
 * adapters: the `CallContext` comes from `@Call()` and the seller session cookie of the request's
 * Market (`@SessionPopulation('seller')`); the controller authenticates only. Who may do what is
 * decided by each use case's gate (permission `sellers.business-identity.edit`, allowed while the
 * seller is not approved) and by the ownership it derives from the actor: no route takes a
 * seller id. Bodies are JSON only and closed; their shape is checked here, their meaning in the
 * domain. A request body is never logged (design 8.3), and a log line holds the outcome code,
 * the Market and the correlation id only.
 *
 * Every response that can carry business data (the draft, a save, a slug check) is
 * `Cache-Control: no-store`, errors included.
 */
@ApiTags('sellers')
@SessionPopulation('seller')
@Controller('sellers/my-file')
export class MyFileController {
  readonly #logger = new Logger('MyFileController');

  constructor(
    private readonly myFileRead: MyFileRead,
    private readonly saveGeneral: MyFileSaveGeneral,
    private readonly saveAddress: MyFileSaveAddress,
    private readonly checkSlug: MyFileCheckSlug,
    private readonly formDescriptors: FormDescriptorsRead,
  ) {}

  @Get()
  @ApiOperation({
    summary: "The seller's own draft, decrypted",
    description:
      'The General group, the addresses, the service area the postcode falls in now, the zone ' +
      'and what is still missing. Personal data: the answer is not cached.',
  })
  @ApiOkResponse({ type: MyFileBody })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable or access.unavailable',
  })
  async read(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MyFileBody> {
    response.setHeader('Cache-Control', NO_STORE);
    const result = await this.myFileRead.execute(context, {});
    return this.settle('sellers.my-file-read', context, response, result, 'read');
  }

  @Put('general')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Save the General group of the draft',
    description:
      'Store name, business name, phone and contact email replace the saved group; an absent, ' +
      'null or blank field is "not entered". The first save needs a phone. Refused on a file ' +
      'with an approved revision (file.change-request-required). The body is never logged.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: SaveGeneralRequest })
  @ApiOkResponse({ type: DraftSavedBody })
  @ApiBadRequestResponse({
    type: SellersErrorBody,
    description: 'validation.failed (details.fields: paths and codes) or phone.required',
  })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'request.csrf or access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiConflictResponse({
    type: SellersErrorBody,
    description: 'file.change-request-required or conflict.stale (read again and retry)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: SellersErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: SellersErrorBody,
    description: 'request.throttled (details.retryAfterSeconds, Retry-After)',
  })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable or access.unavailable',
  })
  async putGeneral(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<DraftSavedBody> {
    response.setHeader('Cache-Control', NO_STORE);
    const input = this.shapeOf(
      'sellers.my-file-save-general',
      context,
      request,
      body,
      parseGeneralBody,
    );
    const result = await this.saveGeneral.execute(context, input);
    return this.settle('sellers.my-file-save-general', context, response, result, 'saved');
  }

  @Put('address')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Save the address group of the draft',
    description:
      "The operating address (and the registered one when it differs) in the Market's format, " +
      'and optionally the zone. The answer says at once whether the postcode is inside an area ' +
      'that takes new sellers; an address outside is kept (AC 6). The body is never logged.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: SaveAddressRequest })
  @ApiOkResponse({ type: AddressSavedBody })
  @ApiBadRequestResponse({
    type: SellersErrorBody,
    description: 'validation.failed (details.fields: paths and codes) or timezone.not-selectable',
  })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'request.csrf or access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiConflictResponse({
    type: SellersErrorBody,
    description: 'file.change-request-required or conflict.stale (read again and retry)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: SellersErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: SellersErrorBody,
    description: 'request.throttled (details.retryAfterSeconds, Retry-After)',
  })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable or access.unavailable',
  })
  async putAddress(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<AddressSavedBody> {
    response.setHeader('Cache-Control', NO_STORE);
    const input = this.shapeOf(
      'sellers.my-file-save-address',
      context,
      request,
      body,
      parseAddressBody,
    );
    const result = await this.saveAddress.execute(context, input);
    return this.settle('sellers.my-file-save-address', context, response, result, 'saved');
  }

  @Post('slug-check')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Check whether a shop slug is available to this seller',
    description:
      'A POST so the slug stays out of URLs and logs. The answer never says who holds a slug. ' +
      'slug.available is not a promise: the first submission holds the slug. Reads only; counted ' +
      'against the slug-check limit of the account.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: CheckSlugRequest })
  @ApiOkResponse({ type: SlugCheckBody })
  @ApiBadRequestResponse({
    type: SellersErrorBody,
    description: 'validation.failed (details.fields)',
  })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'request.csrf or access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiConflictResponse({ type: SellersErrorBody, description: 'file.change-request-required' })
  @ApiUnsupportedMediaTypeResponse({ type: SellersErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: SellersErrorBody,
    description: 'request.throttled (details.retryAfterSeconds, Retry-After)',
  })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable or access.unavailable',
  })
  async postSlugCheck(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<SlugCheckBody> {
    response.setHeader('Cache-Control', NO_STORE);
    const input = this.shapeOf('sellers.my-file-check-slug', context, request, body, parseSlugBody);
    const result = await this.checkSlug.execute(context, input);
    return this.settle('sellers.my-file-check-slug', context, response, result, 'checked');
  }

  @Get('form-descriptors')
  @ApiOperation({
    summary: "The form descriptors of the seller's Market",
    description:
      'Address fields in order with label keys and bounds, the postcode pattern, the regions, ' +
      'the zones per region and the phone bound. Market configuration; nothing personal.',
  })
  @ApiOkResponse({ type: FormDescriptorsBody })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable or access.unavailable',
  })
  async descriptors(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<FormDescriptorsBody> {
    const result = await this.formDescriptors.execute(context, {});
    return this.settle('sellers.form-descriptors-read', context, response, result, 'read');
  }

  /** Checks the content type and the body's shape; throws the 415 or 400 answer. Logs a refusal. */
  private shapeOf<T>(
    msg: string,
    context: CallContext,
    request: Request,
    body: unknown,
    parse: (body: unknown) => T | readonly FieldProblem[],
  ): T {
    if (request.is('application/json') !== 'application/json') {
      this.log(msg, context, 'request.body-unsupported');
      throw fail(415, 'request.body-unsupported');
    }
    const parsed = parse(body);
    if (Array.isArray(parsed)) {
      this.log(msg, context, 'validation.failed');
      throw fail(400, 'validation.failed', { fields: parsed });
    }
    return parsed as T;
  }

  /** Logs the outcome code, then answers the value or throws the mapped error. */
  private settle<T>(
    msg: string,
    context: CallContext,
    response: Response,
    result: Result<T, MyFileError>,
    okCode: string,
  ): T {
    this.log(msg, context, result.ok ? okCode : result.error.code);
    if (!result.ok) throw errorOf(result.error, response);
    return result.value;
  }

  private log(msg: string, context: CallContext, outcome: string): void {
    this.#logger.log({
      msg,
      outcome,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
