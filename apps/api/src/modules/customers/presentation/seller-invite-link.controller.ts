import { Controller, Get, HttpCode, Logger, Post, Res } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { SellerInviteLinkRefresh } from '../application/use-cases/seller-invite-link-refresh.use-case';
import { SellerInviteLinkView } from '../application/use-cases/seller-invite-link-view.use-case';
import { refusal } from './http-answers';

const ERROR = { type: Object };
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'access.unauthenticated or session.invalid';

/**
 * The shop's invite link (customers management phase 4a): read it, and draw a new one that revokes
 * the old. The answer carries the token only; the panel builds the storefront link
 * (`<storefront>/invite/<token>`) and its QR code. Every answer is `Cache-Control: no-store`.
 */
@ApiTags('customers')
@RoutePopulation('seller')
@ReadsSession()
@Controller('customers/seller/invite-link')
export class SellerInviteLinkController {
  readonly #logger = new Logger('SellerInviteLinkController');

  constructor(
    private readonly view: SellerInviteLinkView,
    private readonly refresh: SellerInviteLinkRefresh,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The shop’s invite link and how many customers joined through it',
    description:
      'Needs customers.seller-invite-link.manage; refused while the shop is not approved and in a ' +
      'Login as Seller session. `link` is null until a team member draws one. `signups` counts the ' +
      'customers who joined through any of the shop’s links: active, and rejected (the shop’s own ' +
      'team, or an admin).',
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

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Draw a new invite link (the old one stops working)',
    description:
      'Needs customers.seller-invite-link.manage. The customers who joined through the old link stay ' +
      'the shop’s. Audited. No body.',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: Object })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'customers.unavailable' })
  async draw(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.refresh.execute(context, {});
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }
}
