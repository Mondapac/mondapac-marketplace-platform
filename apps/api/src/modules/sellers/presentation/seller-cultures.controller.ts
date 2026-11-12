import { Body, Controller, Get, HttpCode, Logger, Param, Post, Req, Res } from '@nestjs/common';
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
  ApiProperty,
  ApiPropertyOptional,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { SellerCultureDecide } from '../application/use-cases/seller-culture-decide.use-case';
import { SellerCulturesAdminList } from '../application/use-cases/seller-cultures-admin-list.use-case';
import { SellerCulturesOwn } from '../application/use-cases/seller-cultures-own.use-case';
import { SellerCulturesRequest } from '../application/use-cases/seller-cultures-request.use-case';
import { fail } from './my-file.answer';
import { SellersErrorBody } from './my-file.dto';

/** The HTTP status of each failure of the culture routes (the gate's refusals keep theirs). */
export const SELLER_CULTURE_STATUS = {
  'validation.failed': 400,
  'file.not-found': 404,
  'culture.membership-not-found': 404,
  'culture.not-requested': 409,
  'culture.not-active': 409,
  'culture.certificate-required': 409,
  'culture.certificate-unavailable': 503,
  'sellers.unavailable': 503,
} as const;

type CultureError =
  | { readonly code: keyof typeof ACCESS_DENIED_STATUS }
  | {
      readonly code: keyof typeof SELLER_CULTURE_STATUS;
      readonly fields?: readonly { readonly path: string; readonly code: string }[];
      readonly requiredCertificationType?: string;
    };

function cultureErrorOf(error: CultureError): HttpException {
  if (error.code in ACCESS_DENIED_STATUS) {
    return fail(ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS], error.code);
  }
  const code = error.code as keyof typeof SELLER_CULTURE_STATUS;
  const status = SELLER_CULTURE_STATUS[code];
  if ('fields' in error && error.fields !== undefined) {
    return fail(status, code, { fields: error.fields });
  }
  if ('requiredCertificationType' in error && error.requiredCertificationType !== undefined) {
    return fail(status, code, { requiredCertificationType: error.requiredCertificationType });
  }
  return fail(status, code);
}

export class SellerCultureBody {
  @ApiProperty({ format: 'uuid' }) cultureId!: string;
  @ApiProperty({ description: 'The culture code (fixed; never a certification claim).' })
  cultureCode!: string;
  @ApiProperty({ description: 'Name by locale; empty when the culture cannot be read.' })
  names!: Record<string, string>;
  @ApiProperty({ enum: ['draft', 'active', 'inactive', 'unknown'] })
  cultureStatus!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The certification type a member must hold a valid certificate of, or null.',
  })
  requiredCertificationType!: string | null;
  @ApiProperty({ enum: ['requested', 'approved', 'rejected'] }) status!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The reviewer reason; set on a rejection.',
  })
  reason!: string | null;
  @ApiProperty({ description: 'An instant in UTC (ISO 8601).' }) requestedAt!: string;
  @ApiProperty({ nullable: true, type: String }) decidedAt!: string | null;
  @ApiProperty({
    description:
      'True while the request waits and the culture needs a certificate: show "Needs a valid <certificate> certificate". For a reviewer it is true only when the seller holds none.',
  })
  needsCertificate!: boolean;
  @ApiPropertyOptional({
    enum: ['not-required', 'held', 'missing', 'unavailable'],
    description: 'Reviewer lists only.',
  })
  certificate?: string;
  @ApiProperty({ description: 'The version of the membership.' }) version!: number;
}

export class RequestedCultureBody extends SellerCultureBody {
  @ApiProperty({ enum: ['requested', 'requested-again', 'unchanged'] }) outcome!: string;
}

export class SellerCulturesBody {
  @ApiProperty({ type: [SellerCultureBody] }) cultures!: SellerCultureBody[];
}

export class RequestedCulturesBody {
  @ApiProperty({ type: [RequestedCultureBody] }) cultures!: RequestedCultureBody[];
}

export class SellerCulturesRequestBody {
  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: 20,
    description: 'Active cultures of the Market, distinct. Several at once are allowed (signup).',
  })
  cultureIds!: string[];
}

export class SellerCultureDecisionRequest {
  @ApiProperty({ enum: ['approve', 'reject'] }) decision!: string;
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 300,
    description: 'Required for a rejection. Must not contain personal data.',
  })
  reason?: string;
}

export class SellerCultureDecisionBody {
  @ApiProperty({ type: SellerCultureBody }) culture!: SellerCultureBody;
}

const UNAUTH = { type: SellersErrorBody, description: 'session.invalid or access.unauthenticated' };

/**
 * The acting seller's cultures (multi-culture package 2; screen S1) over HTTP. A thin adapter: the
 * `CallContext` comes from `@Call()` and the seller session cookie; the seller is the actor's and
 * no route takes a seller id. Allowed before approval. Answers are `Cache-Control: no-store`.
 */
@ApiTags('sellers')
@RoutePopulation('seller')
@ReadsSession()
@Controller('sellers/own-cultures')
export class SellerOwnCulturesController {
  readonly #logger = new Logger('SellerOwnCulturesController');

  constructor(
    private readonly own: SellerCulturesOwn,
    private readonly request: SellerCulturesRequest,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'My cultures (seller)',
    description:
      'The acting seller’s cultures with the status of each and the reviewer’s reason. A request for ' +
      'a culture with a required certificate shows needsCertificate until a reviewer approves.',
  })
  @ApiOkResponse({ type: SellerCulturesBody })
  @ApiUnauthorizedResponse(UNAUTH)
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerCulturesBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.own.execute(context, {});
    this.#logger.log({
      msg: 'sellers.seller-cultures-own-route',
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw cultureErrorOf(result.error);
    return { cultures: result.value.cultures.map((c) => ({ ...c })) };
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Request cultures (seller)',
    description:
      'Asks to join one or more ACTIVE cultures of the Market at once. A culture already ' +
      'requested or approved is left as it is (outcome unchanged); a rejected one is requested ' +
      'again. A reviewer decides each; a certificate is checked at approval, not here.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: SellerCulturesRequestBody })
  @ApiCreatedResponse({ type: RequestedCulturesBody })
  @ApiBadRequestResponse({
    type: SellersErrorBody,
    description: 'validation.failed (details.fields; cultureIds.N not-active)',
  })
  @ApiUnauthorizedResponse(UNAUTH)
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'request.csrf or access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiUnsupportedMediaTypeResponse({ type: SellersErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async post(
    @Call() context: CallContext,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<RequestedCulturesBody> {
    response.setHeader('Cache-Control', 'no-store');
    if (httpRequest.is('application/json') !== 'application/json') {
      throw fail(415, 'request.body-unsupported');
    }
    const result = await this.request.execute(context, { body });
    this.#logger.log({
      msg: 'sellers.seller-cultures-request-route',
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw cultureErrorOf(result.error);
    return { cultures: result.value.cultures.map((c) => ({ ...c })) };
  }
}

/**
 * A seller's culture memberships for a reviewer (screen A5). Who may do it is the use case's gate
 * (`sellers.seller-file.review`). An unsafe request also needs `Origin` on the Market's admin list,
 * `Sec-Fetch-Site: same-origin` and the CSRF header. The body is JSON only and closed.
 */
@ApiTags('sellers')
@RoutePopulation('admin')
@ReadsSession()
@Controller('sellers/admin')
export class SellerCulturesAdminController {
  readonly #logger = new Logger('SellerCulturesAdminController');

  constructor(
    private readonly list: SellerCulturesAdminList,
    private readonly decide: SellerCultureDecide,
  ) {}

  @Get(':sellerId/cultures')
  @ApiOperation({
    summary: 'Culture memberships of a seller (admin)',
    description:
      'Each membership with its status and reason; for a culture with a required certificate, ' +
      'certificate (held, missing or unavailable) and needsCertificate. Needs ' +
      'sellers.seller-file.review.',
  })
  @ApiParam({ name: 'sellerId', description: 'The seller id (UUID).' })
  @ApiOkResponse({ type: SellerCulturesBody })
  @ApiUnauthorizedResponse(UNAUTH)
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async get(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerCulturesBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, { sellerId });
    this.#logger.log({
      msg: 'sellers.seller-cultures-admin-list-route',
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw cultureErrorOf(result.error);
    return { cultures: result.value.cultures.map((c) => ({ ...c })) };
  }

  @Post(':sellerId/cultures/:cultureId/decision')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve or reject a culture membership (admin)',
    description:
      'Decides a waiting request. A rejection needs a reason (1 to 300 characters). To approve a ' +
      'culture with a required certification type the seller must hold a valid, approved, unexpired ' +
      'certificate of that type (culture.certificate-required with details.requiredCertificationType; ' +
      'culture.certificate-unavailable when it cannot be read). Needs sellers.seller-file.review ' +
      '(and certification.seller-certificate.view for the certificate check).',
  })
  @ApiParam({ name: 'sellerId', description: 'The seller id (UUID).' })
  @ApiParam({ name: 'cultureId', description: 'The culture id (UUID).' })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: SellerCultureDecisionRequest })
  @ApiOkResponse({ type: SellerCultureDecisionBody })
  @ApiBadRequestResponse({ type: SellersErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse(UNAUTH)
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'request.csrf or access.denied' })
  @ApiNotFoundResponse({
    type: SellersErrorBody,
    description: 'file.not-found or culture.membership-not-found',
  })
  @ApiConflictResponse({
    type: SellersErrorBody,
    description: 'culture.not-requested, culture.not-active or culture.certificate-required',
  })
  @ApiUnsupportedMediaTypeResponse({ type: SellersErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable or culture.certificate-unavailable',
  })
  async post(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Param('cultureId') cultureId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<SellerCultureDecisionBody> {
    response.setHeader('Cache-Control', 'no-store');
    if (request.is('application/json') !== 'application/json') {
      throw fail(415, 'request.body-unsupported');
    }
    const result = await this.decide.execute(context, { sellerId, cultureId, body });
    this.#logger.log({
      msg: 'sellers.seller-culture-decide-route',
      outcome: result.ok ? result.value.culture.status : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw cultureErrorOf(result.error);
    return { culture: { ...result.value.culture } };
  }
}
