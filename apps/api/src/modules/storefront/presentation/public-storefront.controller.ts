import { Controller, Get, Logger, Param, Res } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import type {
  PublicFailure,
  PublishedAnswer,
} from '../application/use-cases/view-published-page.use-case';
import { ViewPublishedLandingPage } from '../application/use-cases/view-published-landing-page.use-case';
import { ViewPublishedStorefrontNavigation } from '../application/use-cases/view-published-navigation.use-case';
import { ViewPublishedStorefrontPage } from '../application/use-cases/view-published-page.use-case';
import { refusal } from './http-answers';
import { PublishedBody, publishedBody } from './storefront.dto';

const ERROR = { type: Object };

/**
 * The published storefront layouts, for the buyer app. No session is read: the actor is the
 * Market's anonymous actor and the Market is the request's. Only published (or approved)
 * versions are answered; product, category and seller data come from their own routes. Not
 * cacheable yet (`no-store`), like every other public route.
 */
@ApiTags('storefront')
@RoutePopulation('customer')
@Controller('storefront')
export class PublicStorefrontController {
  readonly #logger = new Logger('PublicStorefrontController');

  constructor(
    private readonly page: ViewPublishedStorefrontPage,
    private readonly landing: ViewPublishedLandingPage,
    private readonly navigation: ViewPublishedStorefrontNavigation,
  ) {}

  private answer(
    msg: string,
    context: CallContext,
    result: Result<PublishedAnswer, PublicFailure | { readonly code: string }>,
  ) {
    this.#logger.log({
      msg,
      outcome: result.ok ? result.value.kind : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return publishedBody(result.value);
  }

  @Get('pages/:key')
  @ApiOperation({
    summary: 'The published layout of a system page (public)',
    description:
      'No session needed. key is a system page (home, offers, express, category, search, product, ' +
      'sellers, seller, cart, ...). A page never published answers its template defaults (versionNo null).',
  })
  @ApiParam({ name: 'key' })
  @ApiOkResponse({ type: PublishedBody })
  @ApiNotFoundResponse({ ...ERROR, description: 'storefront.page-not-found' })
  async systemPage(
    @Call() context: CallContext,
    @Param('key') key: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'storefront.view-published-page-route',
      context,
      await this.page.execute(context, { key }),
    );
  }

  @Get('landing/:slug')
  @ApiOperation({
    summary: 'A live landing page at /l/<slug> (public)',
    description:
      'No session needed. kind page: the published layout. kind redirect: an old or archived slug; ' +
      'the buyer app sends the buyer to `to`.',
  })
  @ApiParam({ name: 'slug' })
  @ApiOkResponse({ type: PublishedBody })
  @ApiNotFoundResponse({ ...ERROR, description: 'storefront.page-not-found' })
  async landingPage(
    @Call() context: CallContext,
    @Param('slug') slug: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'storefront.view-published-landing-page-route',
      context,
      await this.landing.execute(context, { slug }),
    );
  }

  @Get('navigation')
  @ApiOperation({
    summary: 'The approved navigation (public)',
    description:
      'No session needed. Slots rail, drawer-popular and drawer-categories; empty until a platform ' +
      'admin approves a navigation. The Browse products button and the mobile bottom bar are fixed in the app.',
  })
  @ApiOkResponse({ type: PublishedBody })
  async navigationLayout(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'storefront.view-published-navigation-route',
      context,
      await this.navigation.execute(context, {}),
    );
  }
}
