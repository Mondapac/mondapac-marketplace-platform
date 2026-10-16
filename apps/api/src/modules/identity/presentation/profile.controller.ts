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
import { ChangePanelPreferences } from '../application/use-cases/change-panel-preferences.use-case';
import { adminBody, adminFailure } from './admin.answer';
import { ApiErrorBody } from './customer-sign-up.dto';
import {
  ChangeDisplayNameRequest,
  ChangePanelPreferencesRequest,
  DisplayNameChanged,
  PanelPreferencesChanged,
} from './profile.dto';

/** One route, one answer for both panels: the actor's own display name (profile package). */
async function answerChangeDisplayName(
  logger: Logger,
  msg: string,
  context: CallContext,
  request: Request,
  response: Response,
  body: unknown,
  useCase: ChangeDisplayName,
): Promise<DisplayNameChanged> {
  const input = adminBody(request, body, ['displayName'] as const);
  let outcome: DisplayNameChanged | HttpException;
  if (input instanceof HttpException) outcome = input;
  else {
    const result = await useCase.execute(context, { displayName: input.displayName });
    if (result.ok) {
      response.setHeader('Cache-Control', 'no-store');
      outcome = result.value;
    } else outcome = adminFailure(response, result.error);
  }
  logger.log({
    msg,
    outcome:
      outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  if (outcome instanceof HttpException) throw outcome;
  return outcome;
}

/** Same shape for the preferences route: both panels, the actor's own account. */
async function answerChangePreferences(
  logger: Logger,
  msg: string,
  context: CallContext,
  request: Request,
  response: Response,
  body: unknown,
  useCase: ChangePanelPreferences,
): Promise<PanelPreferencesChanged> {
  const input = adminBody(request, body, ['timezone', 'locale'] as const);
  let outcome: PanelPreferencesChanged | HttpException;
  if (input instanceof HttpException) outcome = input;
  else {
    const result = await useCase.execute(context, {
      timezone: input.timezone,
      locale: input.locale,
    });
    if (result.ok) {
      response.setHeader('Cache-Control', 'no-store');
      outcome = result.value;
    } else outcome = adminFailure(response, result.error);
  }
  logger.log({
    msg,
    outcome:
      outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  if (outcome instanceof HttpException) throw outcome;
  return outcome;
}

/**
 * The signed-in admin's own profile over HTTP: `PUT profile/display-name`. Reads the admin
 * session cookie and needs its CSRF token. The use case takes the account from the session, so
 * the body names none. Never logs the name.
 */
@ApiTags('identity')
@RoutePopulation('admin')
@Controller('identity/admin')
export class AdminProfileController {
  readonly #logger = new Logger('AdminProfileController');

  constructor(
    private readonly changeDisplayName: ChangeDisplayName,
    private readonly changePreferences: ChangePanelPreferences,
  ) {}

  @Put('profile/display-name')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({ summary: 'Change the display name of the signed-in admin account' })
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
  changeOwnDisplayName(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<DisplayNameChanged> {
    return answerChangeDisplayName(
      this.#logger,
      'identity.admin-change-display-name',
      context,
      request,
      response,
      body,
      this.changeDisplayName,
    );
  }
  @Put('profile/preferences')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({ summary: 'Set the time zone and language of the signed-in admin account' })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: ChangePanelPreferencesRequest })
  @ApiOkResponse({ type: PanelPreferencesChanged })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed (details.fields: timezone or locale not supported)',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf or access.denied' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  changeOwnPreferences(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<PanelPreferencesChanged> {
    return answerChangePreferences(
      this.#logger,
      'identity.admin-change-preferences',
      context,
      request,
      response,
      body,
      this.changePreferences,
    );
  }
}

/** The same route for a seller-side member, on the seller session. */
@ApiTags('identity')
@RoutePopulation('seller')
@Controller('identity/seller')
export class SellerProfileController {
  readonly #logger = new Logger('SellerProfileController');

  constructor(
    private readonly changeDisplayName: ChangeDisplayName,
    private readonly changePreferences: ChangePanelPreferences,
  ) {}

  @Put('profile/display-name')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Change the display name of the signed-in seller-side account',
    description: "Allowed while the seller is not approved: the name is the holder's own.",
  })
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
  changeOwnDisplayName(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<DisplayNameChanged> {
    return answerChangeDisplayName(
      this.#logger,
      'identity.seller-change-display-name',
      context,
      request,
      response,
      body,
      this.changeDisplayName,
    );
  }
  @Put('profile/preferences')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({ summary: 'Set the time zone and language of the signed-in seller-side account' })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: ChangePanelPreferencesRequest })
  @ApiOkResponse({ type: PanelPreferencesChanged })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed (details.fields: timezone or locale not supported)',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf or access.denied' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  changeOwnPreferences(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<PanelPreferencesChanged> {
    return answerChangePreferences(
      this.#logger,
      'identity.seller-change-preferences',
      context,
      request,
      response,
      body,
      this.changePreferences,
    );
  }
}
