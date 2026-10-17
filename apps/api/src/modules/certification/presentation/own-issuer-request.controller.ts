import { Body, Controller, HttpCode, HttpException, Logger, Post, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
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
import { OwnIssuerRequestCreate } from '../application/use-cases/own-issuer-request-create.use-case';
import { closedBody, refusalWith, type Refusal } from './http-answers';
import { IssuerRequestCreateRequest, OwnIssuerRequestView } from './issuer-request.dto';
import { OWN_CERTIFICATE_STATUS } from './own-certificate.controller';
import { CertificationErrorBody } from './own-certificate.dto';

/**
 * The HTTP status of each refusal of the seller's issuer request route: the seller certificate
 * table plus a type without a registry (409).
 */
export const OWN_ISSUER_REQUEST_STATUS: Readonly<Record<string, number>> = Object.freeze({
  ...OWN_CERTIFICATE_STATUS,
  'type.no-issuer-registry': 409,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/** The route takes a larger body read as bytes (configure-app); anything else stays as it is. */
function jsonOf(body: unknown): unknown {
  if (!Buffer.isBuffer(body)) return body;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * "My issuer is not listed", the seller's side (certification design 7.2; brief s4 a 3): one
 * route that sends the request with its file. A thin adapter over one use case; the guard only
 * authenticates, the rule is the use case's. The log line holds the outcome code and the ids of
 * the call only, never the typed name.
 */
@ApiTags('certification')
@RoutePopulation('seller')
@Controller('certification/seller')
export class OwnIssuerRequestController {
  readonly #logger = new Logger('OwnIssuerRequestController');

  constructor(private readonly create: OwnIssuerRequestCreate) {}

  @Post('issuer-requests')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Ask for an issuer that is not listed',
    description:
      'Needs certification.own-certificate.manage. For an active type whose form takes the issuer ' +
      'from the registry: the issuer name as typed (request text only, never a registry value) and ' +
      'one base64 JPEG, PNG or PDF of at most 10 MiB, checked like a certificate file and stored ' +
      'encrypted. At most 3 requests a day per seller. The draft of the type shows ' +
      'draft-issuer-not-listed until an admin answers.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: IssuerRequestCreateRequest })
  @ApiCreatedResponse({ type: OwnIssuerRequestView })
  @ApiBadRequestResponse({ type: CertificationErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'type.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'type.inactive, type.no-issuer-registry, conflict.stale',
  })
  @ApiPayloadTooLargeResponse({ type: CertificationErrorBody, description: 'file.too-large' })
  @ApiUnprocessableEntityResponse({
    type: CertificationErrorBody,
    description:
      'file.unreadable, file.too-many-pages, file.encrypted, file.active-content, file.too-complex or file.inspection-timeout',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: CertificationErrorBody,
    description: 'file.unsupported-type, request.body-unsupported',
  })
  @ApiTooManyRequestsResponse({ type: CertificationErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async postRequest(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<OwnIssuerRequestView> {
    const input = closedBody(request, jsonOf(body), ['typeCode', 'issuerName', 'data']);
    let outcome: OwnIssuerRequestView | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.create.execute(context, {
        typeCode: input.typeCode,
        issuerName: input.issuerName,
        data: input.data,
      });
      outcome = result.ok ? result.value : this.refusal(result.error, response, context);
    }
    const failed = outcome instanceof HttpException && outcome.getStatus() >= 500;
    this.#logger[failed ? 'warn' : 'log']({
      msg: 'certification.own-issuer-request-create',
      outcome:
        outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }

  private refusal(error: Refusal, response: Response, context: CallContext): HttpException {
    return refusalWith(
      OWN_ISSUER_REQUEST_STATUS,
      error,
      response,
      context,
      'certification.own-issuer-request-unmapped-refusal',
    );
  }
}
