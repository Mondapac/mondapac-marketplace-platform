import { Body, Controller, HttpCode, HttpException, Logger, Put, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
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
import { ChangeDisplayName } from '../application/use-cases/change-display-name.use-case';
import { ChangeStorefrontAppearance } from '../application/use-cases/change-storefront-appearance.use-case';
import type { FieldProblem } from '../application/use-cases/register-customer.use-case';
import { adminBody, adminFailure } from './admin.answer';
import { fail } from './customer-sign-up.controller';
import { ApiErrorBody } from './customer-sign-up.dto';
import { AppearanceChanged, ChangeAppearanceRequest } from './customer-session.dto';
import { ChangeDisplayNameRequest, DisplayNameChanged } from './profile.dto';

const APPEARANCE_FIELDS = ['palette', 'textSize'] as const;

/**
 * The appearance body: exactly `palette` and `textSize`, each a string or null. The values are
 * checked by the use case; unknown fields are refused, never stored.
 */
function appearanceBody(
  request: Request,
  body: unknown,
): { readonly palette: string | null; readonly textSize: string | null } | HttpException {
  if (request.is('application/json') !== 'application/json') {
    return fail(415, 'request.body-unsupported');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail(400, 'validation.failed', { fields: [{ path: '', code: 'type' }] });
  }
  const record = body as Record<string, unknown>;
  const problems: FieldProblem[] = Object.keys(record)
    .filter((key) => !(APPEARANCE_FIELDS as readonly string[]).includes(key))
    .sort()
    .slice(0, 1)
    .map(() => ({ path: '', code: 'unknown-field' }));
  for (const field of APPEARANCE_FIELDS) {
    const value = Object.hasOwn(record, field) ? record[field] : undefined;
    if (value === undefined) problems.push({ path: field, code: 'required' });
    else if (value !== null && typeof value !== 'string') {
      problems.push({ path: field, code: 'type' });
    }
  }
  if (problems.length > 0) return fail(400, 'validation.failed', { fields: problems });
  return {
    palette: record.palette as string | null,
    textSize: record.textSize as string | null,
  };
}

/**
 * The signed-in customer's own profile over HTTP (buyer account backend): the display name and
 * the storefront look kept on the account. Reads the customer session cookie and needs its CSRF
 * token. The use cases take the account from the session, so no body names one. The name is
 * personal data and is never logged; the look is read back from `GET identity/customer/session`.
 */
@ApiTags('identity')
@RoutePopulation('customer')
@Controller('identity/customer')
export class CustomerProfileController {
  readonly #logger = new Logger('CustomerProfileController');

  constructor(
    private readonly changeDisplayName: ChangeDisplayName,
    private readonly changeAppearance: ChangeStorefrontAppearance,
  ) {}

  @Put('profile/display-name')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({ summary: 'Set the display name of the signed-in customer' })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: ChangeDisplayNameRequest })
  @ApiOkResponse({ type: DisplayNameChanged })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed (details.fields: displayName length or characters)',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf or access.denied' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async changeOwnDisplayName(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<DisplayNameChanged> {
    const input = adminBody(request, body, ['displayName'] as const);
    let outcome: DisplayNameChanged | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.changeDisplayName.execute(context, {
        displayName: input.displayName,
      });
      if (result.ok) {
        response.setHeader('Cache-Control', 'no-store');
        outcome = result.value;
      } else outcome = adminFailure(response, result.error);
    }
    return this.settle('identity.customer-change-display-name', context, outcome);
  }

  @Put('profile/appearance')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Keep a storefront look (palette, text size) on the signed-in customer account',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: ChangeAppearanceRequest })
  @ApiOkResponse({ type: AppearanceChanged })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed (details.fields: palette or textSize not supported)',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf or access.denied' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async changeOwnAppearance(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<AppearanceChanged> {
    const input = appearanceBody(request, body);
    let outcome: AppearanceChanged | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.changeAppearance.execute(context, input);
      if (result.ok) {
        response.setHeader('Cache-Control', 'no-store');
        outcome = result.value;
      } else outcome = adminFailure(response, result.error);
    }
    return this.settle('identity.customer-change-appearance', context, outcome);
  }

  /** Logs the outcome code with the correlation id, then answers or throws. */
  private settle<T>(msg: string, context: CallContext, outcome: T | HttpException): T {
    this.#logger.log({
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
