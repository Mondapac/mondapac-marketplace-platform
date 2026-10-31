import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Logger,
  Param,
  Put,
  Req,
  Res,
  StreamableFile,
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
  ApiPayloadTooLargeResponse,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { StoreProfileClaimTerms } from '../application/use-cases/store-profile-claim-terms.use-case';
import { StoreImageReadOwn } from '../application/use-cases/store-image-read-own.use-case';
import { StoreImageRemove } from '../application/use-cases/store-image-remove.use-case';
import { StoreImageSave } from '../application/use-cases/store-image-save.use-case';
import {
  StoreProfileRead,
  type StoreProfileView,
} from '../application/use-cases/store-profile-read.use-case';
import { StoreProfileSaveAbout } from '../application/use-cases/store-profile-save-about.use-case';
import { STORE_ABOUT_MAX_LENGTH } from '../domain/store-about';
import { STORE_IMAGE_MAX_UPLOAD_BYTES, type StoreImageKind } from '../domain/store-image';
import { errorOf, fail, type MyFileError } from './my-file.answer';
import { SellersErrorBody } from './my-file.dto';
import {
  jsonOf,
  parseSaveAboutBody,
  parseSaveImageBody,
  type SaveAboutBody,
  type SaveImageBody,
} from './store-profile.body';

/** The status of the refusals the picture routes add to the draft table. */
const IMAGE_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'image.not-found': 404,
  'file.too-large': 413,
  'file.unsupported-type': 415,
  'file.too-many-pixels': 422,
  'file.too-small': 422,
  'file.unreadable': 422,
});

export class StoreImageRefBody {
  @ApiProperty({ description: 'Names the image in the image routes.' }) id!: string;
  @ApiProperty({ description: 'Pixels of the large size.' }) width!: number;
  @ApiProperty({ description: 'Pixels of the large size.' }) height!: number;
}

export class StoreProfileBody {
  @ApiProperty({
    description: 'Name this as expectedVersion in the next About save (0: never saved).',
  })
  version!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'The About text of each locale of the Market; an empty string where none is written.',
  })
  about!: Record<string, string>;

  @ApiProperty({ description: 'The locale shown on the buyer site.' }) defaultLocale!: string;
  @ApiProperty({ type: [String], description: 'The locales the Market offers.' })
  locales!: string[];
  @ApiProperty({ type: StoreImageRefBody, nullable: true }) logo!: StoreImageRefBody | null;
  @ApiProperty({ type: StoreImageRefBody, nullable: true }) banner!: StoreImageRefBody | null;

  @ApiProperty({ description: 'The longest About text, in characters.' }) aboutMaxLength!: number;
  @ApiProperty({ description: 'The largest picture upload, in bytes.' }) imageMaxBytes!: number;
}

export class ClaimTermsBody {
  @ApiProperty({
    type: [String],
    description:
      'The Market claim terms as plain phrases (NFKC, lower case, tokens joined by one space). ' +
      'For a live warning in the About field only: the save check is the authority.',
  })
  terms!: string[];
}

export class SaveAboutRequest {
  @ApiProperty({ description: 'The version the page read (stale: conflict.stale).' })
  expectedVersion!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'The text of each locale; an empty string clears it.',
  })
  about!: Record<string, string>;
}

export class SaveImageRequest {
  @ApiProperty({
    description:
      'The picture as standard base64 text: JPEG, PNG or WebP, at most 4 MiB of bytes. The panel ' +
      'shrinks it before sending. The type is read from the content.',
  })
  data!: string;
}

const NO_STORE = 'no-store';
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

const bodyOf = (view: StoreProfileView): StoreProfileBody => ({
  version: view.version,
  about: { ...view.about },
  defaultLocale: view.defaultLocale,
  locales: [...view.locales],
  logo: view.logo === null ? null : { ...view.logo },
  banner: view.banner === null ? null : { ...view.banner },
  aboutMaxLength: STORE_ABOUT_MAX_LENGTH,
  imageMaxBytes: STORE_IMAGE_MAX_UPLOAD_BYTES,
});

/**
 * The seller's own store profile over HTTP (sellers design 3.7, 6.2; slice 12 part 2): the About
 * text, the logo and the banner. Every save is public at once. Thin adapters: the `CallContext`
 * comes from `@Call()` and the seller session cookie; the controller authenticates only. Who may
 * do it is the gate's rule (`sellers.store-profile.view` / `.edit`, approved sellers only) and the
 * ownership the use case derives from the actor: no route takes a seller id. Neither a request
 * body nor a text is ever logged.
 */
@ApiTags('sellers')
@RoutePopulation('seller')
@ReadsSession()
@Controller('sellers/store-profile')
export class StoreProfileController {
  readonly #logger = new Logger('StoreProfileController');

  constructor(
    private readonly read: StoreProfileRead,
    private readonly saveAbout: StoreProfileSaveAbout,
    private readonly saveImage: StoreImageSave,
    private readonly removeImage: StoreImageRemove,
    private readonly readImage: StoreImageReadOwn,
    private readonly claimTerms: StoreProfileClaimTerms,
  ) {}

  @Get()
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({
    summary: "The seller's own store profile",
    description:
      'The About text of each Market locale, the logo and banner references, the version a text ' +
      'save must name and the limits. Needs sellers.store-profile.view and an approved seller.',
  })
  @ApiOkResponse({ type: StoreProfileBody })
  @ApiUnauthorizedResponse({ type: SellersErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable or access.unavailable',
  })
  async get(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StoreProfileBody> {
    const result = await this.read.execute(context, {});
    return this.settle('sellers.store-profile-read', context, response, result, 'read');
  }

  @Get('claim-terms')
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({
    summary: 'The certification claim terms of the Market',
    description:
      'Needs sellers.store-profile.view and an approved seller. A read of certification for the ' +
      'About field to warn while the seller types; the About save runs the real check and stays ' +
      'authoritative. Unavailable is sellers.unavailable, never an empty list.',
  })
  @ApiOkResponse({ type: ClaimTermsBody })
  @ApiUnauthorizedResponse({ type: SellersErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable or access.unavailable',
  })
  async getClaimTerms(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ClaimTermsBody> {
    const result = await this.claimTerms.execute(context, {});
    this.#log('sellers.store-profile-claim-terms', context, result.ok ? 'read' : result.error.code);
    if (!result.ok) throw this.#errorOf(result.error, response);
    return { terms: [...result.value] };
  }

  @Put('about')
  @Header('Cache-Control', NO_STORE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Save the About text',
    description:
      'Needs sellers.store-profile.edit. Every save is a new revision that buyers see at once ' +
      '(no review). Texts are trimmed, at most 2000 characters, plain text with no link, no ' +
      'hidden character and no certification claim (about.<locale> with url, characters, length ' +
      'or claim-term in details.fields). A stale expectedVersion is conflict.stale. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SaveAboutRequest })
  @ApiOkResponse({ type: StoreProfileBody })
  @ApiBadRequestResponse({ type: SellersErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: SellersErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'request.csrf or access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiConflictResponse({ type: SellersErrorBody, description: 'conflict.stale (read and retry)' })
  @ApiUnsupportedMediaTypeResponse({ type: SellersErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: SellersErrorBody,
    description: 'request.throttled (details.retryAfterSeconds, Retry-After)',
  })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable or access.unavailable',
  })
  async putAbout(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<StoreProfileBody> {
    const msg = 'sellers.store-profile-save-about';
    this.#requireJson(msg, context, request);
    const parsed = parseSaveAboutBody(body);
    if (Array.isArray(parsed)) {
      this.#log(msg, context, 'validation.failed');
      throw fail(400, 'validation.failed', { fields: parsed });
    }
    const input = parsed as SaveAboutBody;
    const result = await this.saveAbout.execute(context, input);
    return this.settle(msg, context, response, result, 'saved');
  }

  @Put('logo')
  @Header('Cache-Control', NO_STORE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Set or replace the logo',
    description:
      'Needs sellers.store-profile.edit. Decodes the picture and stores two metadata-free JPEG ' +
      'renditions on white (128 and 512 pixels, square, never cropped); the upload itself is ' +
      'not kept. At least 128 by 128 pixels. Public at once; the old logo is deleted. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SaveImageRequest })
  @ApiOkResponse({ type: StoreProfileBody })
  @ApiBadRequestResponse({ type: SellersErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: SellersErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'request.csrf or access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiPayloadTooLargeResponse({ type: SellersErrorBody, description: 'file.too-large' })
  @ApiUnprocessableEntityResponse({
    type: SellersErrorBody,
    description: 'file.too-many-pixels, file.too-small or file.unreadable',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: SellersErrorBody,
    description: 'Not application/json, or file.unsupported-type',
  })
  @ApiTooManyRequestsResponse({ type: SellersErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable or access.unavailable',
  })
  putLogo(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<StoreProfileBody> {
    return this.#putImage('logo', context, request, response, body);
  }

  @Put('banner')
  @Header('Cache-Control', NO_STORE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Set or replace the banner',
    description:
      'Needs sellers.store-profile.edit. As the logo, but the banner is cropped to 4 to 1 at ' +
      'the centre (768 and 1536 pixels wide) and must be at least 1200 by 300 pixels.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SaveImageRequest })
  @ApiOkResponse({ type: StoreProfileBody })
  @ApiBadRequestResponse({ type: SellersErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: SellersErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'request.csrf or access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiPayloadTooLargeResponse({ type: SellersErrorBody, description: 'file.too-large' })
  @ApiUnprocessableEntityResponse({
    type: SellersErrorBody,
    description: 'file.too-many-pixels, file.too-small or file.unreadable',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: SellersErrorBody,
    description: 'Not application/json, or file.unsupported-type',
  })
  @ApiTooManyRequestsResponse({ type: SellersErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable or access.unavailable',
  })
  putBanner(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<StoreProfileBody> {
    return this.#putImage('banner', context, request, response, body);
  }

  @Delete('logo')
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({
    summary: 'Remove the logo',
    description:
      'Needs sellers.store-profile.edit. The logo stops being served at once. Removing what is ' +
      'not there is not an error.',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: StoreProfileBody })
  @ApiUnauthorizedResponse({ type: SellersErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'request.csrf or access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiTooManyRequestsResponse({ type: SellersErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable or access.unavailable',
  })
  deleteLogo(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StoreProfileBody> {
    return this.#deleteImage('logo', context, response);
  }

  @Delete('banner')
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({
    summary: 'Remove the banner',
    description: 'Needs sellers.store-profile.edit. As the logo.',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: StoreProfileBody })
  @ApiUnauthorizedResponse({ type: SellersErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'request.csrf or access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiTooManyRequestsResponse({ type: SellersErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable or access.unavailable',
  })
  deleteBanner(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StoreProfileBody> {
    return this.#deleteImage('banner', context, response);
  }

  @Get('images/:imageId/:size')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; sandbox")
  @ApiOperation({
    summary: 'Read one size of the current logo or banner (preview)',
    description:
      "Needs sellers.store-profile.view. `size` is small or large. Only the seller's current " +
      "image answers; a replaced, removed, unknown or another seller's id is image.not-found. " +
      'The answer is an image/jpeg written by the server.',
  })
  @ApiOkResponse({ description: 'image/jpeg bytes' })
  @ApiUnauthorizedResponse({ type: SellersErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'image.not-found' })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable or access.unavailable',
  })
  async getImage(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('imageId') imageId: string,
    @Param('size') size: string,
  ): Promise<StreamableFile> {
    const msg = 'sellers.store-image-read-own';
    const result = await this.readImage.execute(context, { imageId, size });
    this.#log(msg, context, result.ok ? 'read' : result.error.code);
    if (!result.ok) throw this.#errorOf(result.error, response);
    return new StreamableFile(result.value.bytes, { type: result.value.contentType });
  }

  async #putImage(
    kind: StoreImageKind,
    context: CallContext,
    request: Request,
    response: Response,
    body: unknown,
  ): Promise<StoreProfileBody> {
    const msg = 'sellers.store-image-save';
    this.#requireJson(msg, context, request);
    const parsed = parseSaveImageBody(jsonOf(body));
    if (Array.isArray(parsed)) {
      this.#log(msg, context, 'validation.failed');
      throw fail(400, 'validation.failed', { fields: parsed });
    }
    const result = await this.saveImage.execute(context, {
      kind,
      data: (parsed as SaveImageBody).data,
    });
    return this.settle(msg, context, response, result, 'saved');
  }

  async #deleteImage(
    kind: StoreImageKind,
    context: CallContext,
    response: Response,
  ): Promise<StoreProfileBody> {
    const result = await this.removeImage.execute(context, { kind });
    return this.settle('sellers.store-image-remove', context, response, result, 'removed');
  }

  #requireJson(msg: string, context: CallContext, request: Request): void {
    if (request.is('application/json') !== 'application/json') {
      this.#log(msg, context, 'request.body-unsupported');
      throw fail(415, 'request.body-unsupported');
    }
  }

  #errorOf(error: { readonly code: string }, response: Response) {
    const status = IMAGE_STATUS[error.code];
    return status === undefined
      ? errorOf(error as MyFileError, response)
      : fail(status, error.code);
  }

  private settle(
    msg: string,
    context: CallContext,
    response: Response,
    result: Result<StoreProfileView, { readonly code: string }>,
    okCode: string,
  ): StoreProfileBody {
    this.#log(msg, context, result.ok ? okCode : result.error.code);
    if (!result.ok) throw this.#errorOf(result.error, response);
    return bodyOf(result.value);
  }

  #log(msg: string, context: CallContext, outcome: string): void {
    this.#logger.log({
      msg,
      outcome,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
