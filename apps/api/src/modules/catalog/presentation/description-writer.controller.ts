import { Body, Controller, Get, Header, HttpCode, Logger, Post, Req, Res } from '@nestjs/common';
import type { HttpException } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
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
import type {
  WriterAvailability,
  WriterDraft,
} from '../application/ai/description-writer.flow';
import { AdminAiModelSetup } from '../application/use-cases/admin-ai-model-setup.use-case';
import { AdminDescriptionDraft } from '../application/use-cases/admin-description-draft.use-case';
import { AdminDescriptionWriterStatus } from '../application/use-cases/admin-description-writer-status.use-case';
import { OwnDescriptionDraft } from '../application/use-cases/own-description-draft.use-case';
import { OwnDescriptionWriterStatus } from '../application/use-cases/own-description-writer-status.use-case';
import {
  MAX_CATEGORY_CHARS,
  MAX_DETAILS,
  MAX_KEYWORDS,
  MAX_KEYWORD_CHARS,
  MAX_NOTE_CHARS,
  MAX_TITLE_CHARS,
  WRITER_LENGTHS,
  WRITER_TONES,
} from '../domain/description-writer/writer-request';
import { fail, refusalWith } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/** The HTTP status of each refusal of the writer's routes. */
export const DESCRIPTION_WRITER_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'access.denied': 403,
  'access.acting-as-refused': 403,
  'ai.writer-off': 409,
  'ai.draft-withheld': 422,
  'ai.limit-reached': 429,
  'request.throttled': 429,
  'access.unavailable': 503,
  'ai.writer-failed': 503,
});

class WriterDetailRequest {
  @ApiProperty({ maxLength: 60 }) name!: string;
  @ApiProperty({ maxLength: 120 }) value!: string;
}

export class DescriptionDraftRequest {
  @ApiProperty({ maxLength: MAX_TITLE_CHARS, description: 'The title as the form has it.' })
  title!: string;
  @ApiProperty({ maxLength: MAX_CATEGORY_CHARS, description: 'The category label the form shows.' })
  category!: string;
  @ApiPropertyOptional({ type: [WriterDetailRequest], maxItems: MAX_DETAILS })
  details?: WriterDetailRequest[];
  @ApiPropertyOptional({ type: [String], maxItems: MAX_KEYWORDS, description: `Each at most ${String(MAX_KEYWORD_CHARS)} characters.` })
  keywords?: string[];
  @ApiPropertyOptional({ maxLength: MAX_NOTE_CHARS })
  note?: string;
  @ApiPropertyOptional({ enum: [...WRITER_TONES], default: 'clear-friendly' })
  tone?: string;
  @ApiPropertyOptional({ enum: [...WRITER_LENGTHS], default: 80 })
  length?: number;
}

class LeftOutBody {
  @ApiProperty() certification!: number;
  @ApiProperty() other!: number;
}

export class DescriptionDraftBody {
  @ApiProperty({ description: 'Plain text; paragraphs split by a blank line. Show as text.' })
  text!: string;
  @ApiProperty({ type: LeftOutBody }) leftOut!: LeftOutBody;
  @ApiProperty() promptVersion!: string;
}

export class DescriptionWriterStatusBody {
  @ApiProperty({ description: 'False: hide "Write with AI".' }) available!: boolean;
  @ApiProperty({ description: "The Market's IANA zone; the daily drafts reset at its midnight." })
  resetZone!: string;
}

class AiModelsBody {
  @ApiProperty({ type: String, nullable: true }) fast!: string | null;
  @ApiProperty({ type: String, nullable: true }) balanced!: string | null;
}

export class AiModelSetupBody {
  @ApiProperty() killSwitch!: boolean;
  @ApiProperty({ description: 'Whether a key is set; the key never leaves the server.' })
  keyConfigured!: boolean;
  @ApiProperty({ type: AiModelsBody }) models!: AiModelsBody;
}

const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const DRAFT_DESCRIPTION =
  'The draft uses only the fields sent (title, category label, product details, keywords, note); ' +
  'no image, price, tag or other data goes to the model. Nothing is stored: put the text into the ' +
  'field only when the user chooses "Use text"; it is saved only with the form and passes the ' +
  'same claim-text refusal as typed text. Sentences naming a certification, a health claim, a ' +
  'price, stock or delivery, or a number not in the input are left out (counted in leftOut). ' +
  'ai.writer-off (409): hide the button. ai.limit-reached (429, details.resetZone): drafts are ' +
  'used up until midnight in that zone. ai.writer-failed (503): try again or write it yourself.';

function settle<T>(
  logger: Logger,
  msg: string,
  context: CallContext,
  response: Response,
  result: Result<T, { readonly code: string; readonly retryAfterSeconds?: number }>,
): T {
  logger.log({
    msg,
    outcome: result.ok ? 'ok' : result.error.code,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  if (result.ok) return result.value;
  throw refusalWith(DESCRIPTION_WRITER_STATUS, result.error, response, context) as HttpException;
}

function jsonOnly(request: Request): void {
  if (request.is('application/json') !== 'application/json') {
    throw fail(415, 'request.body-unsupported');
  }
}

/**
 * The AI description writer for sellers (AIS-03): whether it is offered, and one draft. Seller
 * session of the request's Market; `catalog.own-product.edit`; no AI in an acting-as session.
 */
@ApiTags('catalog')
@RoutePopulation('seller')
@Controller('catalog/own/description-writer')
export class OwnDescriptionWriterController {
  readonly #logger = new Logger('OwnDescriptionWriterController');

  constructor(
    private readonly status: OwnDescriptionWriterStatus,
    private readonly draft: OwnDescriptionDraft,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Whether "Write with AI" is offered to this seller now',
    description:
      "Needs catalog.own-product.edit. True only when the Market's switch and the seller's " +
      'switch are on and a model is configured; false in an acting-as session.',
  })
  @ApiOkResponse({ type: DescriptionWriterStatusBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  async get(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WriterAvailability> {
    const result = await this.status.execute(context, {});
    return settle(this.#logger, 'catalog.own-description-writer-status', context, response, result);
  }

  @Post('drafts')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({ summary: 'Write a description draft with AI (seller)', description: DRAFT_DESCRIPTION })
  @ApiHeader(CSRF)
  @ApiBody({ type: DescriptionDraftRequest })
  @ApiOkResponse({ type: DescriptionDraftBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied, access.acting-as-refused or request.csrf' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'ai.writer-off' })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: 'ai.draft-withheld (details.leftOut)' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'ai.limit-reached or request.throttled' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'ai.writer-failed or access.unavailable' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async post(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<WriterDraft> {
    jsonOnly(request);
    const result = await this.draft.execute(context, { body });
    return settle(this.#logger, 'catalog.own-description-draft', context, response, result);
  }
}

/**
 * The AI description writer for admins on platform products (AIS-03, owner decision 2026-10-31),
 * and the model setup the admin AI settings card shows. Admin session of the request's Market.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/description-writer')
export class AdminDescriptionWriterController {
  readonly #logger = new Logger('AdminDescriptionWriterController');

  constructor(
    private readonly status: AdminDescriptionWriterStatus,
    private readonly draft: AdminDescriptionDraft,
    private readonly modelSetup: AdminAiModelSetup,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Whether "Write with AI" is offered to this admin now',
    description:
      "Needs catalog.platform-product.edit. True only when the Market's switch is on and a " +
      'model is configured; false in an acting-as session.',
  })
  @ApiOkResponse({ type: DescriptionWriterStatusBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  async get(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WriterAvailability> {
    const result = await this.status.execute(context, {});
    return settle(this.#logger, 'catalog.admin-description-writer-status', context, response, result);
  }

  @Get('model-setup')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: "The Market's AI model setup (admin, read only)",
    description:
      'Needs settings.ai.view. Whether AI_KILL_SWITCH is set, whether a key is set, and the ' +
      'model id of each tier. Server configuration: the panel cannot change these.',
  })
  @ApiOkResponse({ type: AiModelSetupBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  async setup(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    const result = await this.modelSetup.execute(context, {});
    return settle(this.#logger, 'catalog.admin-ai-model-setup', context, response, result);
  }

  @Post('drafts')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({ summary: 'Write a description draft with AI (admin)', description: DRAFT_DESCRIPTION })
  @ApiHeader(CSRF)
  @ApiBody({ type: DescriptionDraftRequest })
  @ApiOkResponse({ type: DescriptionDraftBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied, access.acting-as-refused or request.csrf' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'ai.writer-off' })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: 'ai.draft-withheld (details.leftOut)' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'ai.limit-reached or request.throttled' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'ai.writer-failed or access.unavailable' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async post(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<WriterDraft> {
    jsonOnly(request);
    const result = await this.draft.execute(context, { body });
    return settle(this.#logger, 'catalog.admin-description-draft', context, response, result);
  }
}
