import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ArchiveOwnBlogPost } from '../application/use-cases/seller-archive-post.use-case';
import { ChangeOwnBlogEventStatus } from '../application/use-cases/seller-change-event-status.use-case';
import { CreateOwnBlogPost } from '../application/use-cases/seller-create-post.use-case';
import { ListBlogTaxonomyForSeller } from '../application/use-cases/seller-list-taxonomy.use-case';
import { ListOwnBlogPosts } from '../application/use-cases/seller-list-posts.use-case';
import { SubmitOwnBlogPost } from '../application/use-cases/seller-submit-post.use-case';
import { UpdateOwnBlogPostDraft } from '../application/use-cases/seller-update-draft.use-case';
import { ViewOwnBlogPost } from '../application/use-cases/seller-view-post.use-case';
import { closedBody, plain, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const BODY = { type: Object };
const POST = { name: 'post', description: 'A post id of the seller.' };
const UNAUTHORIZED = { ...ERROR, description: 'access.unauthenticated or session.invalid' };
const FORBIDDEN = {
  ...ERROR,
  description: 'access.denied, access.seller-not-approved, blog.access-off or request.csrf',
};
const BAD = { ...ERROR, description: 'validation.failed (details.fields)' };
const NOT_FOUND = { ...ERROR, description: "blog.post-not-found (also for another seller's post)" };
const CONFLICT = {
  ...ERROR,
  description:
    'blog.wrong-state, blog.post-archived, blog.quota-used, blog.version-limit or blog.slug-taken',
};

/**
 * A seller's own blog posts. Every route needs `blog.seller-post.edit` and, besides, an admin's
 * switch of the seller's blog access (`blog.access-off` otherwise); a seller reaches its own posts
 * only, and another seller's post is a 404 like an unknown id. The first send of a post for review
 * uses one unit of the month's quota (`blog.quota-used` when none is left). Every answer is
 * `Cache-Control: no-store`.
 */
@ApiTags('blog')
@RoutePopulation('seller')
@ReadsSession()
@Controller('blog/seller')
export class SellerBlogController {
  readonly #logger = new Logger('SellerBlogController');

  constructor(
    private readonly list: ListOwnBlogPosts,
    private readonly create: CreateOwnBlogPost,
    private readonly view: ViewOwnBlogPost,
    private readonly updateDraft: UpdateOwnBlogPostDraft,
    private readonly submit: SubmitOwnBlogPost,
    private readonly archive: ArchiveOwnBlogPost,
    private readonly eventStatus: ChangeOwnBlogEventStatus,
    private readonly taxonomy: ListBlogTaxonomyForSeller,
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

  private body(request: Request, body: unknown, keys: readonly string[]): void {
    const invalid = closedBody(request, body, keys);
    if (invalid !== null) throw invalid;
  }

  @Get('taxonomy')
  @ApiOperation({
    summary: 'The categories and tags to pick from (seller)',
    description: 'Needs blog.seller-post.edit.',
  })
  @ApiOkResponse(BODY)
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  async categories(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'blog.seller-list-taxonomy-route',
      context,
      await this.taxonomy.execute(context, undefined),
    );
  }

  @Get('posts')
  @ApiOperation({
    summary: "The seller's own posts",
    description:
      'Needs blog.seller-post.edit. Newest first, 50 a page; filters: status, kind, page.',
  })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'kind', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiOkResponse(BODY)
  @ApiBadRequestResponse(BAD)
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  async index(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'blog.seller-list-posts-route',
      context,
      await this.list.execute(context, { query: request.query }),
    );
  }

  @Post('posts')
  @ApiOperation({
    summary: "Create the seller's own post, as a draft",
    description:
      'Needs blog.seller-post.edit. Body { kind, slug?, content }. A seller post links only to ' +
      'products, the seller and brands, and has no byline of its own. It uses no quota until it is sent.',
  })
  @ApiHeader(CSRF)
  @ApiBody(BODY)
  @ApiCreatedResponse(BODY)
  @ApiBadRequestResponse(BAD)
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiConflictResponse(CONFLICT)
  async post(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.body(request, body, ['kind', 'slug', 'content']);
    return this.answer(
      'blog.seller-create-post-route',
      context,
      await this.create.execute(context, { body }),
    );
  }

  @Get('posts/:post')
  @ApiOperation({
    summary: "One of the seller's own posts",
    description:
      "Needs blog.seller-post.edit. Carries the reviewer's note when changes were requested.",
  })
  @ApiParam(POST)
  @ApiOkResponse(BODY)
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  async one(
    @Call() context: CallContext,
    @Param('post') post: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'blog.seller-view-post-route',
      context,
      await this.view.execute(context, { post }),
    );
  }

  @Put('posts/:post/draft')
  @HttpCode(200)
  @ApiOperation({
    summary: "Save the draft of the seller's own post",
    description:
      'Needs blog.seller-post.edit. Body { content, slug? }; the whole content is replaced.',
  })
  @ApiHeader(CSRF)
  @ApiParam(POST)
  @ApiBody(BODY)
  @ApiOkResponse(BODY)
  @ApiBadRequestResponse(BAD)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async saveDraft(
    @Call() context: CallContext,
    @Param('post') post: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.body(request, body, ['content', 'slug']);
    return this.answer(
      'blog.seller-update-draft-route',
      context,
      await this.updateDraft.execute(context, { post, body }),
    );
  }

  @Post('posts/:post/submit')
  @HttpCode(200)
  @ApiOperation({
    summary: "Send the seller's post for review",
    description:
      'Needs blog.seller-post.edit. Runs the automatic checks first (422 blog.checks-failed). The ' +
      "first send of a post uses one unit of the month's quota, counted in the Market's time zone " +
      '(409 blog.quota-used when none is left).',
  })
  @ApiHeader(CSRF)
  @ApiParam(POST)
  @ApiOkResponse(BODY)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async submitPost(
    @Call() context: CallContext,
    @Param('post') post: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'blog.seller-submit-post-route',
      context,
      await this.submit.execute(context, { post }),
    );
  }

  @Post('posts/:post/archive')
  @HttpCode(200)
  @ApiOperation({
    summary: "Archive the seller's own post",
    description:
      'Needs blog.seller-post.edit. The post leaves the site; this is the seller\'s "delete".',
  })
  @ApiHeader(CSRF)
  @ApiParam(POST)
  @ApiOkResponse(BODY)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async archivePost(
    @Call() context: CallContext,
    @Param('post') post: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'blog.seller-archive-post-route',
      context,
      await this.archive.execute(context, { post }),
    );
  }

  @Put('posts/:post/event-status')
  @HttpCode(200)
  @ApiOperation({
    summary: "Change the status of the seller's own event at once",
    description:
      'Needs blog.seller-post.edit. Body { status, message? }. Takes effect on the live post ' +
      'without a review, and is audited. A message is checked first (no outside link, no ' +
      'certification claim; 422 blog.checks-failed).',
  })
  @ApiHeader(CSRF)
  @ApiParam(POST)
  @ApiBody(BODY)
  @ApiOkResponse(BODY)
  @ApiBadRequestResponse(BAD)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async changeEventStatus(
    @Call() context: CallContext,
    @Param('post') post: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.body(request, body, ['status', 'message']);
    return this.answer(
      'blog.seller-change-event-status-route',
      context,
      await this.eventStatus.execute(context, { post, body }),
    );
  }
}
