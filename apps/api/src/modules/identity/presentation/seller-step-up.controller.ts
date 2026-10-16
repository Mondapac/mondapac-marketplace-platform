import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Post,
  Req,
  Res,
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
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
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
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import { ListSellerStepUpPolicy } from '../application/use-cases/list-seller-step-up-policy.use-case';
import { SetSellerStepUpPolicy } from '../application/use-cases/set-seller-step-up-policy.use-case';
import { VerifySellerStepUp } from '../application/use-cases/verify-seller-step-up.use-case';
import { adminBody, adminFailure } from './admin.answer';
import { fail } from './customer-sign-up.controller';
import { ApiErrorBody } from './customer-sign-up.dto';
import {
  StepUpPolicySet,
  StepUpPolicySetRequest,
  StepUpPolicyView,
  StepUpVerified,
  StepUpVerifyRequest,
} from './seller-step-up.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/**
 * The two-step rules per action of a seller's shop over HTTP (seller OTP policy, 2026-10-16).
 * The shop is the session's (R6): no route takes a seller id. Every route reads the seller
 * session, so an unsafe method needs the CSRF token and the seller panel's origin (6.4); JSON
 * only, with a closed body. Thin adapters: each route calls one use case through its gate and
 * logs its outcome code with the correlation id; never a code or an address.
 *
 * - `GET policy`: every member reads the rules (the Owner's panel edits them).
 * - `POST policy`: the Seller Owner turns one action's code on or off, with a fresh code.
 * - `POST verify`: any member presents a code for one action; the guarded action then accepts
 *   it for a few minutes. A guarded action that has no proof answers `second-factor.required`
 *   (403, `details.actionKey`); the panel shows the code dialog, calls `verify`, and repeats.
 */
@ApiTags('identity')
@RoutePopulation('seller')
@Controller('identity/seller/step-up')
export class SellerStepUpController {
  readonly #logger = new Logger('SellerStepUpController');

  constructor(
    private readonly listPolicy: ListSellerStepUpPolicy,
    private readonly setPolicy: SetSellerStepUpPolicy,
    private readonly verify: VerifySellerStepUp,
  ) {}

  @Get('policy')
  @ReadsSession()
  @ApiOperation({
    summary: "Read the shop's two-step rules per action",
    description:
      'Every member of an approved shop. One row per registered action: `required` is what ' +
      'applies now (the platform floor, the shop rule or the default); `locked` rows are always ' +
      'required. Changing a rule needs the Seller Owner (identity.step-up-policy.manage, see ' +
      '`permissionKeys` of the session summary). Not cached.',
  })
  @ApiOkResponse({ type: StepUpPolicyView })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  async policy(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StepUpPolicyView> {
    const result = await this.listPolicy.execute(context, {});
    response.setHeader('Cache-Control', 'no-store');
    if (!result.ok) {
      const refused = adminFailure(response, result.error);
      this.#logger.log({
        msg: 'identity.seller-step-up-policy-list',
        outcome: result.error.code,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      throw refused;
    }
    return {
      items: result.value.items.map((item) => ({
        ...item,
        updatedAt: item.updatedAt === null ? null : item.updatedAt.toString(),
      })),
    };
  }

  @Post('policy')
  @HttpCode(200)
  @ReadsSession()
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Turn the two-step code for one action on or off',
    description:
      'The Seller Owner only (identity.step-up-policy.manage). Needs a current code (app or ' +
      'recovery code): saving a rule is itself sensitive. A locked action cannot be turned off ' +
      '(step-up.locked). A request that changes nothing answers `step-up-policy.unchanged` and ' +
      'spends no code. Every change is audited with the old and new value.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: StepUpPolicySetRequest })
  @ApiOkResponse({ type: StepUpPolicySet })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed or second-factor.invalid',
  })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'step-up.action-unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'step-up.locked or second-factor.unavailable (no two-step set up)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'second-factor.locked' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async set(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<StepUpPolicySet> {
    let outcome: StepUpPolicySet | HttpException;
    const required = isRecord(body) ? body['required'] : undefined;
    if (typeof required !== 'boolean') {
      outcome =
        request.is('application/json') !== 'application/json'
          ? fail(415, 'request.body-unsupported')
          : fail(400, 'validation.failed', {
              fields: [{ path: 'required', code: required === undefined ? 'required' : 'type' }],
            });
    } else {
      const rest = Object.fromEntries(
        Object.entries(body as Record<string, unknown>).filter(([key]) => key !== 'required'),
      );
      const input = adminBody(request, rest, ['actionKey', 'code'] as const);
      if (input instanceof HttpException) outcome = input;
      else {
        const result = await this.setPolicy.execute(context, { ...input, required });
        outcome = result.ok ? result.value : adminFailure(response, result.error);
      }
    }
    response.setHeader('Cache-Control', 'no-store');
    return this.settle('identity.seller-step-up-policy-set', context, outcome);
  }

  @Post('verify')
  @HttpCode(200)
  @ReadsSession()
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Present a two-step code for one action',
    description:
      'Any member of an approved shop with two-step set up. A current code from the app or a ' +
      'recovery code, counted on the same lock-out as every signed-in code. On success this ' +
      'session may do that one action for the next 5 minutes; it covers no other action. Call it ' +
      'when an action answered `second-factor.required`, then repeat that request.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: StepUpVerifyRequest })
  @ApiOkResponse({ type: StepUpVerified })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed or second-factor.invalid',
  })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'step-up.action-unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'second-factor.unavailable (no two-step set up: set it up first)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'second-factor.locked' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async verifyCode(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<StepUpVerified> {
    const input = adminBody(request, body, ['actionKey', 'code'] as const);
    let outcome: StepUpVerified | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.verify.execute(context, input);
      outcome = result.ok ? result.value : adminFailure(response, result.error);
    }
    response.setHeader('Cache-Control', 'no-store');
    return this.settle('identity.seller-step-up-verify', context, outcome);
  }

  /** Logs the outcome code with the correlation id, then answers or throws. */
  private settle<T extends { code: string }>(
    msg: string,
    context: CallContext,
    outcome: T | HttpException,
  ): T {
    this.#logger.log({
      msg,
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
