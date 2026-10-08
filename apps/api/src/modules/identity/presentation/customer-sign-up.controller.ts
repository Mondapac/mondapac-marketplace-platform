import { Body, Controller, HttpCode, HttpException, Logger, Post, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import { clientOriginOf } from '../../../platform/rate-limit/client-origin';
import {
  RegisterCustomer,
  type FieldProblem,
  type RegisterCustomerRequest,
} from '../application/use-cases/register-customer.use-case';
import {
  ApiErrorBody,
  CustomerSignUpAccepted,
  CustomerSignUpRequest,
} from './customer-sign-up.dto';

const FIELDS = ['email', 'password'] as const;

/** At most this many unknown field names are echoed, then one {@link MORE_FIELDS} marker. */
export const MAX_ECHOED_UNKNOWN_FIELDS = 10;
/** The path of the marker that stands for the unknown fields not echoed (U+2026). */
export const MORE_FIELDS = '\u2026';
const MAX_ECHOED_NAME_CODE_POINTS = 64;
/** Control and format characters (bidi overrides, zero-width marks...) and lone surrogates. */
const UNSAFE_IN_NAME = /[\p{Cc}\p{Cf}\p{Cs}]/gu;

/**
 * A client-supplied field name made safe to echo (Hassan L2): lone surrogates and control or
 * format characters become U+FFFD, and the name is cut to 64 code points (never inside a
 * surrogate pair).
 */
export function echoedFieldName(name: string): string {
  return Array.from(name.replace(UNSAFE_IN_NAME, '\uFFFD'))
    .slice(0, MAX_ECHOED_NAME_CODE_POINTS)
    .join('');
}

/**
 * Checks the shape of a closed JSON body of string fields (identity design 5.2): every named
 * field present and a string, no other field; values are never echoed, and an unknown field's
 * name only after {@link echoedFieldName}.
 */
export function parseStringFields<const F extends string>(
  body: unknown,
  fields: readonly F[],
): Readonly<Record<F, string>> | readonly FieldProblem[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return [{ path: '', code: 'type' }];
  }
  const record = body as Record<string, unknown>;
  // An unknown field is refused, never stored: a customer gives no name (`ux.md` A2).
  const unknown = Object.keys(record)
    .filter((key) => !(fields as readonly string[]).includes(key))
    .sort();
  const problems: FieldProblem[] = unknown
    .slice(0, MAX_ECHOED_UNKNOWN_FIELDS)
    .map((key) => ({ path: echoedFieldName(key), code: 'unknown-field' }));
  if (unknown.length > MAX_ECHOED_UNKNOWN_FIELDS) {
    problems.push({ path: MORE_FIELDS, code: 'unknown-field' });
  }
  for (const field of fields) {
    const value = Object.hasOwn(record, field) ? record[field] : undefined;
    if (value === undefined) problems.push({ path: field, code: 'required' });
    else if (typeof value !== 'string') problems.push({ path: field, code: 'type' });
  }
  if (problems.length > 0) return problems;
  return Object.fromEntries(fields.map((field) => [field, record[field] as string])) as Record<
    F,
    string
  >;
}

/**
 * Checks the shape of an email-and-password body (sign-up and sign-in): a closed object of two
 * strings; values are never echoed (identity design 5.2).
 */
export function parseSignUpBody(body: unknown): RegisterCustomerRequest | readonly FieldProblem[] {
  const parsed = parseStringFields(body, FIELDS);
  if (Array.isArray(parsed)) return parsed as readonly FieldProblem[];
  const { email, password } = parsed as Readonly<Record<(typeof FIELDS)[number], string>>;
  return { email, password };
}

/** An answer in the error format of identity design 5.2: `{ statusCode, code, details? }`. */
export function fail(status: number, code: string, details?: object): HttpException {
  return new HttpException({ statusCode: status, code, ...(details ? { details } : {}) }, status);
}

/**
 * Customer sign-up over HTTP (identity design 6.7, 8.6 row 1; CUS-01; slice 1d). A thin
 * adapter: it checks the body's shape, builds nothing itself (the `CallContext` comes from
 * `@Call()`), calls the `RegisterCustomer` use case through its gate and maps the answer to
 * the error format of 5.2. Anonymous identity route: the stricter per-origin limit applies
 * (6.8). JSON only (6.4). Logs the outcome code with the correlation id; never the email or
 * the password.
 */
@ApiTags('identity')
@RateLimit('anonymous-identity')
@Controller('identity/customer/sign-up')
export class CustomerSignUpController {
  readonly #logger = new Logger('CustomerSignUpController');

  constructor(private readonly registerCustomer: RegisterCustomer) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Create a customer account (sign-up)',
    description:
      'Email and password only. The answer is the same whether or not the address already has ' +
      'a customer account in this Market (AC 21); only the mail differs (from slice 3).',
  })
  @ApiBody({ type: CustomerSignUpRequest })
  @ApiAcceptedResponse({ type: CustomerSignUpAccepted })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed (details.fields) or password.rejected (details.rule)',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid: the request carries an Authorization header (HF14)',
  })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description:
      'request.csrf: Sec-Fetch-Site is present and not same-origin, or Origin is present and ' +
      "not on the Market's list (HF14)",
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'request.busy (the password-hash queue is full) or access.unavailable',
  })
  async signUp(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<CustomerSignUpAccepted> {
    const outcome = await this.answer(context, request, response, body);
    this.#logger.log({
      msg: 'identity.customer-sign-up',
      outcome:
        outcome instanceof HttpException
          ? (outcome.getResponse() as { code: string }).code
          : outcome.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }

  private async answer(
    context: CallContext,
    request: Request,
    response: Response,
    body: unknown,
  ): Promise<CustomerSignUpAccepted | HttpException> {
    if (request.is('application/json') !== 'application/json') {
      return fail(415, 'request.body-unsupported');
    }
    const input = parseSignUpBody(body);
    if (Array.isArray(input)) return fail(400, 'validation.failed', { fields: input });
    // The origin of the mail counter, from the socket only (never a forwarded header, HF3).
    const origin = clientOriginOf(request.socket.remoteAddress);
    if (origin === null) return fail(503, 'access.unavailable');

    const result = await this.registerCustomer.execute(context, {
      ...(input as RegisterCustomerRequest),
      origin,
    });
    if (result.ok) return result.value;
    const error = result.error;
    switch (error.code) {
      case 'validation.failed':
        return fail(400, error.code, { fields: error.fields });
      case 'password.rejected':
        return fail(400, error.code, { rule: error.rule });
      case 'request.busy':
        response.setHeader('Retry-After', String(error.retryAfterSeconds));
        return fail(503, error.code, { retryAfterSeconds: error.retryAfterSeconds });
      case 'access.seller-not-approved':
        return fail(ACCESS_DENIED_STATUS[error.code], error.code, error.details);
      default:
        return fail(ACCESS_DENIED_STATUS[error.code], error.code);
    }
  }
}
