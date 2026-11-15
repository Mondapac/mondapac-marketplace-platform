import { Controller, Get, Logger, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { ViewPublicStorefrontSeo } from '../application/use-cases/view-public-seo.use-case';
import { PublicSeoBody } from './seo.dto';

/**
 * The Market's SEO settings for the buyer app. No session is read: the actor is the Market's
 * anonymous actor and the Market is the request host's. Only public fields are answered (never the
 * version, the editor or a focus keyword). Not cacheable here (`no-store`); the buyer app caches.
 */
@ApiTags('storefront')
@RoutePopulation('customer')
@Controller('storefront/seo')
export class PublicSeoController {
  readonly #logger = new Logger('PublicSeoController');

  constructor(private readonly view: ViewPublicStorefrontSeo) {}

  @Get()
  @ApiOperation({
    summary: 'The SEO settings of the Market (public)',
    description:
      'No session needed. Answers the code defaults (indexing off) while an admin has saved nothing. ' +
      'The effective indexing rule (env ceiling, this setting, sample data) is applied by the buyer app.',
  })
  @ApiOkResponse({ type: PublicSeoBody })
  async read(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    this.#logger.log({
      msg: 'storefront.view-public-seo-route',
      outcome: result.ok ? 'read' : 'refused',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    // The use case cannot fail ("never"); a refusal here would be the gate's.
    if (!result.ok) throw new Error('storefront.view-public-seo refused');
    return { seo: result.value };
  }
}
