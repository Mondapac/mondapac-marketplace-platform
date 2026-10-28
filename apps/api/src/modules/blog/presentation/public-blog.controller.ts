import { Controller, Get, Logger, Param, Query, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { ListPublishedBlogPosts } from '../application/use-cases/view-published-posts.use-case';
import { ViewPublicBlogTaxonomy } from '../application/use-cases/view-public-taxonomy.use-case';
import { ViewPublishedBlogPost } from '../application/use-cases/view-published-post.use-case';
import { ViewUpcomingBlogEvents } from '../application/use-cases/view-upcoming-events.use-case';
import { plain, refusal } from './http-answers';

const ERROR = { type: Object };
const BODY = { type: Object };

/**
 * The blog for buyers. No session is read: the actor is the Market's anonymous actor and the Market
 * is the request's. Only the live version of a published post is answered. Not cacheable yet
 * (`no-store`), like every other public route.
 */
@ApiTags('blog')
@RoutePopulation('customer')
@Controller('blog')
export class PublicBlogController {
  readonly #logger = new Logger('PublicBlogController');

  constructor(
    private readonly posts: ListPublishedBlogPosts,
    private readonly post: ViewPublishedBlogPost,
    private readonly events: ViewUpcomingBlogEvents,
    private readonly taxonomy: ViewPublicBlogTaxonomy,
  ) {}

  private answer<T>(
    msg: string,
    context: CallContext,
    result: Result<T, { readonly code: string } & Record<string, unknown>>,
  ): unknown {
    this.#logger.log({
      msg,
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return plain(result.value);
  }

  @Get('posts')
  @ApiOperation({
    summary: 'The live posts of the Market (public)',
    description:
      "No session needed. Newest first, the featured post first, paged by the Market's page size. " +
      'Filters: kind (product, brand, event, news), category (a category address), tag (a tag address), page.',
  })
  @ApiQuery({ name: 'kind', required: false })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'tag', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiOkResponse(BODY)
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  async list(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'blog.list-published-route',
      context,
      await this.posts.execute(context, { query: request.query }),
    );
  }

  @Get('events/upcoming')
  @ApiOperation({
    summary: 'The upcoming events (public)',
    description: 'No session needed. Live event posts that have not ended, soonest first.',
  })
  @ApiOkResponse(BODY)
  async upcoming(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'blog.upcoming-events-route',
      context,
      await this.events.execute(context, undefined),
    );
  }

  @Get('taxonomy')
  @ApiOperation({
    summary: 'The categories and tags (public)',
    description: "No session needed. Category names in the asked locale, or the Market's default.",
  })
  @ApiQuery({ name: 'locale', required: false })
  @ApiOkResponse(BODY)
  async categories(
    @Call() context: CallContext,
    @Query('locale') locale: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'blog.public-taxonomy-route',
      context,
      await this.taxonomy.execute(context, { locale }),
    );
  }

  @Get('posts/:slug')
  @ApiOperation({
    summary: 'One live post by its address (public)',
    description:
      'No session needed. { kind: "post", post } for a live post; { kind: "redirect", slug } for an ' +
      'old address (the buyer app sends the reader to the new one). A post that was on the site and ' +
      'was taken off or archived answers 410; an unknown address, 404.',
  })
  @ApiParam({ name: 'slug' })
  @ApiOkResponse(BODY)
  @ApiNotFoundResponse({ ...ERROR, description: 'blog.not-found' })
  @ApiGoneResponse({ ...ERROR, description: 'blog.gone' })
  async one(
    @Call() context: CallContext,
    @Param('slug') slug: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'blog.view-published-post-route',
      context,
      await this.post.execute(context, { slug }),
    );
  }
}
