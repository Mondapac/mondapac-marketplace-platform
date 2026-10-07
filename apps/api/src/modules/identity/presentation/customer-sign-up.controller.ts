import { Body, Controller, HttpCode, HttpException, Logger, Post, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import {
  RegisterCustomer,
  type FieldProblem,
  type RegisterCustomerInput,
} from '../application/use-cases/register-customer.use-case';
import {
  ApiErrorBody,
  CustomerSignUpAccepted,
  CustomerSignUpRequest,
} from './customer-sign-up.dto';

const FIELDS = ['email', 'password'] as const;

/** Checks the shape of the body; values are never echoed (identity design 5.2). */
export function parseSignUpBody(body: unknown): RegisterCustomerInput | readonly FieldProblem[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return [{ path: '', code: 'type' }];
  }
  const record = body as Record<string, unknown>;
  const problems: FieldProblem[] = Object.keys(record)
    .filter((key) => !(FIELDS as readonly string[]).includes(key))
    .sort()
    // An unknown field is refused, never stored: a customer gives no name (`ux.md` A2).
    .map((key) => ({ path: key.slice(0, 64), code: 'unknown-field' }));
  for (const field of FIELDS) {
    const value = record[field];
    if (value === undefined) problems.push({ path: field, code: 'required' });
    else if (typeof value !== 'string') problems.push({ path: field, code: 'type' });
  }
  if (problems.length > 0) return problems;
  return { email: record.email as string, password: record.password as string };
}

function fail(status: number, code: string, details?: object): HttpException {
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

    const result = await this.registerCustomer.execute(context, input as RegisterCustomerInput);
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
