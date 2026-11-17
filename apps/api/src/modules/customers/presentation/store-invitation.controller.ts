import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Param,
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
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { JoinStoreByInvitation } from '../application/use-cases/join-store-by-invitation.use-case';
import { ResolveStoreInvitation } from '../application/use-cases/resolve-store-invitation.use-case';
import { ViewOwnStoreInvitation } from '../application/use-cases/view-own-store-invitation.use-case';
import { closedBody, refusal } from './http-answers';

const ERROR = { type: Object };
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'access.unauthenticated or session.invalid';

/**
 * A store's invite link on the storefront (customers management phase 4a): which store a link
 * leads to (anyone), and the signed-in customer's claim of it and read of the store they joined
 * through. Every answer is `Cache-Control: no-store`.
 */
@ApiTags('customers')
@RoutePopulation('customer')
@Controller('customers/store-invitations')
export class StoreInvitationController {
  readonly #logger = new Logger('StoreInvitationController');

  constructor(private readonly resolve: ResolveStoreInvitation) {}

  @Get(':token')
  @ApiOperation({
    summary: 'The store an invite link leads to',
    description:
      'Anonymous. The store’s address (`slug`) only: the storefront reads the store page by it for ' +
      'the invite banner and the sign-up line. An unknown, revoked or malformed token and a store ' +
      'that is not public now are one answer.',
  })
  @ApiOkResponse({ type: Object })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.invitation-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'customers.unavailable' })
  async store(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('token') token: string,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.resolve.execute(context, { token });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }
}

/** The signed-in customer's own side of an invite link. */
@ApiTags('customers')
@RoutePopulation('customer')
@ReadsSession()
@Controller('customers/me/store-invitation')
export class OwnStoreInvitationController {
  readonly #logger = new Logger('OwnStoreInvitationController');

  constructor(
    private readonly join: JoinStoreByInvitation,
    private readonly view: ViewOwnStoreInvitation,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The store the customer joined through',
    description:
      '`store` is null when the customer joined through no store’s link. `slug` is null while the ' +
      'store is not public. For the account’s privacy line.',
  })
  @ApiOkResponse({ type: Object })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'customers.unavailable' })
  async read(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Join a store through its invite link',
    description:
      'Body `{ token }`. For a new account only (signed up within the Market’s window, no order yet, ' +
      'not joined through another store); one store for good. The store is followed for the ' +
      'customer (`following`). `customers.unavailable` right after sign-up means "ask again shortly".',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.invitation-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'customers.invitation-not-eligible' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'customers.unavailable' })
  async claim(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, ['token']);
    if (checked instanceof HttpException) throw checked;
    const result = await this.join.execute(context, body);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }
}
