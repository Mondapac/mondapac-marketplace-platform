import {
  Body,
  Controller,
  Delete,
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
  ApiPayloadTooLargeResponse,
  ApiProduces,
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
import { ApproveBlogPost } from '../application/use-cases/approve-post.use-case';
import { ArchiveBlogPost } from '../application/use-cases/archive-post.use-case';
import { ChangeBlogEventStatus } from '../application/use-cases/change-event-status.use-case';
import { CreateBlogPost } from '../application/use-cases/create-post.use-case';
import { EditBlogPostInReview } from '../application/use-cases/reviewer-edit.use-case';
import { FeatureBlogPost } from '../application/use-cases/feature-post.use-case';
import { ListBlogPosts } from '../application/use-cases/list-posts.use-case';
import { ExportBlogPosts } from '../application/use-cases/export-posts.use-case';
import { EXPORT_FORMATS, writeChunks } from '../../../platform/list-export';
import { PauseBlogPost } from '../application/use-cases/pause-post.use-case';
import { PrepareBlogPostCopy } from '../application/use-cases/prepare-post-copy.use-case';
import { PublishBlogPost } from '../application/use-cases/publish-post.use-case';
import { RenameBlogPostSlug } from '../application/use-cases/rename-post-slug.use-case';
import { RequestBlogPostChanges } from '../application/use-cases/request-changes.use-case';
import { ResumeBlogPost } from '../application/use-cases/resume-post.use-case';
import { RunBlogPostChecks } from '../application/use-cases/run-checks.use-case';
import { ScheduleBlogPost } from '../application/use-cases/schedule-post.use-case';
import { SubmitBlogPost } from '../application/use-cases/submit-post.use-case';
import { UnscheduleBlogPost } from '../application/use-cases/unschedule-post.use-case';
import { UpdateBlogPostDraft } from '../application/use-cases/update-draft.use-case';
import { ViewBlogPost } from '../application/use-cases/view-post.use-case';
import { closedBody, plain, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const POST = { name: 'post', description: 'A post id.' };
const UNAUTHORIZED = { ...ERROR, description: 'access.unauthenticated or session.invalid' };
const FORBIDDEN = { ...ERROR, description: 'access.denied or request.csrf' };
const NOT_FOUND = { ...ERROR, description: 'blog.post-not-found' };
const BAD = { ...ERROR, description: 'validation.failed (details.fields)' };
const CONFLICT = {
  ...ERROR,
  description:
    'blog.wrong-state, blog.post-archived, blog.slug-taken, blog.version-limit or conflict.stale',
};
const BODY = { type: Object };

/**
 * The posts of the blog, for admins: list, create, change the draft, send for review, review
 * (checks, edit, approve, send back), go live (now or scheduled), pause, resume, archive, rename the
 * address, feature, change an event's status, and the package that copies a post to another Market.
 * Thin adapters: each use case does its work behind its gate. Unsafe requests carry a session
 * cookie, so the Origin and Sec-Fetch-Site checks and the CSRF token apply as on every admin route.
 * Every answer is `Cache-Control: no-store`.
 */
@ApiTags('blog')
@RoutePopulation('admin')
@ReadsSession()
@Controller('blog/admin/posts')
export class AdminBlogController {
  readonly #logger = new Logger('AdminBlogController');

  constructor(
    private readonly list: ListBlogPosts,
    private readonly create: CreateBlogPost,
    private readonly view: ViewBlogPost,
    private readonly updateDraft: UpdateBlogPostDraft,
    private readonly reviewerEdit: EditBlogPostInReview,
    private readonly submit: SubmitBlogPost,
    private readonly checks: RunBlogPostChecks,
    private readonly approve: ApproveBlogPost,
    private readonly requestChanges: RequestBlogPostChanges,
    private readonly publish: PublishBlogPost,
    private readonly schedule: ScheduleBlogPost,
    private readonly unschedule: UnscheduleBlogPost,
    private readonly pause: PauseBlogPost,
    private readonly resume: ResumeBlogPost,
    private readonly archive: ArchiveBlogPost,
    private readonly renameSlug: RenameBlogPostSlug,
    private readonly feature: FeatureBlogPost,
    private readonly eventStatus: ChangeBlogEventStatus,
    private readonly copy: PrepareBlogPostCopy,
    private readonly exportPosts: ExportBlogPosts,
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

  @Get()
  @ApiOperation({
    summary: 'The posts of the Market (the Blog posts super list, admin)',
    description:
      'Needs blog.post.read. Views: `view` all (default) or one status (`status` is the older ' +
      'name of the view, never with `view`), with `counts` of every view. Filters: kind, owner, ' +
      'sellerId, featured (true or false), q (part of the title or slug, at most 100 ' +
      'characters; never echoed), from/to on the last change. Sort: created (default), updated, ' +
      'published, scheduled (not published or not scheduled last), direction. Paging: page and ' +
      'pageSize (default 25, at most 100, up to row 10,000) with `total` and `hasMore`, or ' +
      '`cursor` and `limit` (newest created first; no page, pageSize, sort or direction). Each ' +
      'row has `actions`: open, and the lifecycle actions its state allows and the caller holds ' +
      'the key of (edit, submit and archive on platform posts only). An unknown key is refused.',
  })
  @ApiQuery({ name: 'view', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'kind', required: false })
  @ApiQuery({ name: 'owner', required: false })
  @ApiQuery({ name: 'sellerId', required: false })
  @ApiQuery({ name: 'featured', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'sort', required: false })
  @ApiQuery({ name: 'direction', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'pageSize', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse(BODY)
  @ApiBadRequestResponse(BAD)
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async index(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'blog.list-posts-route',
      context,
      await this.list.execute(context, { query: request.query }),
    );
  }

  @Get('export')
  @ApiOperation({
    summary: 'The Blog posts list as a CSV or XLSX file (admin)',
    description:
      'Needs blog.post.read. `format` csv (default) or xlsx; `columns` adds slug, seller-id, ' +
      'stage, featured, scheduled, published, created (comma-separated); post id, title, type, ' +
      'author, status and updated are always there. No body, excerpt or author text is written; ' +
      'titles are text (a CSV cell that starts like a formula is guarded). The posts are `ids` ' +
      '(comma-separated, at most 200; an id that is not a post of the Market refuses the whole ' +
      'file as not found) or the view, filters and sort of the list, at most 10,000 (more: ' +
      'batch.too-large with the total). An unknown key is refused.',
  })
  @ApiQuery({ name: 'format', required: false, enum: EXPORT_FORMATS })
  @ApiQuery({ name: 'columns', required: false })
  @ApiQuery({ name: 'ids', required: false })
  @ApiProduces('text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiOkResponse({
    description: 'blog-posts-<date>.csv or blog-posts-<date>.xlsx, as an attachment',
  })
  @ApiBadRequestResponse(BAD)
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max, total)' })
  async download(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.exportPosts.execute(context, { query: request.query });
    this.#logger.log({
      msg: 'blog.export-posts-route',
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) {
      const error = refusal(result.error, context, this.#logger);
      response
        .status(error.getStatus())
        .setHeader('Cache-Control', 'no-store')
        .json(error.getResponse());
      return;
    }
    const { filename, contentType, chunks } = result.value;
    response.status(200);
    response.setHeader('Content-Type', contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await writeChunks(response, chunks);
    } catch {
      // The status line is gone: end the connection, so the client sees a failed download.
      this.#logger.warn({
        msg: 'blog.export-posts-route',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
  }

  @Post()
  @ApiOperation({
    summary: 'Create a platform post, as a draft (admin)',
    description:
      'Needs blog.post.edit. Body { kind, slug?, content, copied? }; the content is plain text and ' +
      'a closed list of blocks, never HTML. copied: true marks a post made from the package of ' +
      'another Market. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody(BODY)
  @ApiCreatedResponse(BODY)
  @ApiBadRequestResponse(BAD)
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiConflictResponse({ ...ERROR, description: 'blog.slug-taken' })
  async post(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.body(request, body, ['kind', 'slug', 'content', 'copied']);
    return this.answer(
      'blog.create-post-route',
      context,
      await this.create.execute(context, { body }),
    );
  }

  @Get(':post')
  @ApiOperation({
    summary: 'A post: working version, live version and versions (admin)',
    description: 'Needs blog.post.read.',
  })
  @ApiParam(POST)
  @ApiOkResponse(BODY)
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse(NOT_FOUND)
  async one(
    @Call() context: CallContext,
    @Param('post') post: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer('blog.view-post-route', context, await this.view.execute(context, { post }));
  }

  @Put(':post/draft')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Save the draft of a platform post (admin)',
    description:
      'Needs blog.post.edit. Body { content, slug? }; the whole content is replaced. A returned, ' +
      'approved or live post starts a new draft from what is sent. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam(POST)
  @ApiBody(BODY)
  @ApiOkResponse(BODY)
  @ApiBadRequestResponse(BAD)
  @ApiUnauthorizedResponse(UNAUTHORIZED)
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
      'blog.update-draft-route',
      context,
      await this.updateDraft.execute(context, { post, body }),
    );
  }

  @Post(':post/reviewer-edit')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Edit a post in review (admin reviewer)',
    description:
      'Needs blog.post.review. Body { content }. The edit is a new version flagged as the ' +
      "reviewer's, still in review under the same sender; the author is told by an event. The " +
      'approver must then be neither the writer, the sender nor this reviewer.',
  })
  @ApiHeader(CSRF)
  @ApiParam(POST)
  @ApiBody(BODY)
  @ApiOkResponse(BODY)
  @ApiBadRequestResponse(BAD)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async reviewEdit(
    @Call() context: CallContext,
    @Param('post') post: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.body(request, body, ['content']);
    return this.answer(
      'blog.reviewer-edit-route',
      context,
      await this.reviewerEdit.execute(context, { post, body }),
    );
  }

  @Post(':post/submit')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Send the draft for review (admin)',
    description:
      'Needs blog.post.edit. Runs the automatic checks first: an error finding refuses with 422 ' +
      'blog.checks-failed (details.findings).',
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
      'blog.submit-post-route',
      context,
      await this.submit.execute(context, { post }),
    );
  }

  @Get(':post/checks')
  @ApiOperation({
    summary: 'The automatic checks of the version in work (admin reviewer)',
    description:
      'Needs blog.post.review. Every finding with its severity (error, warning or notice), its code ' +
      'and the path in the content; no value of the content is repeated.',
  })
  @ApiParam(POST)
  @ApiOkResponse(BODY)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse(NOT_FOUND)
  async runChecks(
    @Call() context: CallContext,
    @Param('post') post: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'blog.run-checks-route',
      context,
      await this.checks.execute(context, { post }),
    );
  }

  @Post(':post/approve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve the version in review (admin reviewer)',
    description:
      'Needs blog.post.review. Body { versionNo }. Refused (403 blog.self-approval-refused) when the ' +
      'approver wrote or sent the version, unless the Market allows a self-approval; then a fresh ' +
      'two-step code is needed first (403 second-factor.required) and the approval is audited as ' +
      'a self-approval. The checks run again and an error finding refuses (422).',
  })
  @ApiHeader(CSRF)
  @ApiParam(POST)
  @ApiBody(BODY)
  @ApiOkResponse(BODY)
  @ApiBadRequestResponse(BAD)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async approvePost(
    @Call() context: CallContext,
    @Param('post') post: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.body(request, body, ['versionNo']);
    return this.answer(
      'blog.approve-post-route',
      context,
      await this.approve.execute(context, { post, body }),
    );
  }

  @Post(':post/request-changes')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Send the version in review back to its author (admin reviewer)',
    description: 'Needs blog.post.review. Body { versionNo, note }.',
  })
  @ApiHeader(CSRF)
  @ApiParam(POST)
  @ApiBody(BODY)
  @ApiOkResponse(BODY)
  @ApiBadRequestResponse(BAD)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async requestPostChanges(
    @Call() context: CallContext,
    @Param('post') post: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.body(request, body, ['versionNo', 'note']);
    return this.answer(
      'blog.request-changes-route',
      context,
      await this.requestChanges.execute(context, { post, body }),
    );
  }

  @Post(':post/publish')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Make the approved version live now (admin)',
    description:
      'Needs blog.post.publish (protected). Body { versionNo }. Refused for a seller post while ' +
      "the seller's blog access is off.",
  })
  @ApiHeader(CSRF)
  @ApiParam(POST)
  @ApiBody(BODY)
  @ApiOkResponse(BODY)
  @ApiBadRequestResponse(BAD)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async publishPost(
    @Call() context: CallContext,
    @Param('post') post: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.body(request, body, ['versionNo']);
    return this.answer(
      'blog.publish-post-route',
      context,
      await this.publish.execute(context, { post, body }),
    );
  }

  @Put(':post/schedule')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Schedule the approved version (admin)',
    description:
      'Needs blog.post.publish. Body { versionNo, scheduledAt }: an instant with an offset, after ' +
      'now and within a year. The worker makes it live at that time.',
  })
  @ApiHeader(CSRF)
  @ApiParam(POST)
  @ApiBody(BODY)
  @ApiOkResponse(BODY)
  @ApiBadRequestResponse(BAD)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async schedulePost(
    @Call() context: CallContext,
    @Param('post') post: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.body(request, body, ['versionNo', 'scheduledAt']);
    return this.answer(
      'blog.schedule-post-route',
      context,
      await this.schedule.execute(context, { post, body }),
    );
  }

  @Delete(':post/schedule')
  @ApiOperation({
    summary: 'Remove the schedule (admin)',
    description: 'Needs blog.post.publish. The version stays approved.',
  })
  @ApiHeader(CSRF)
  @ApiParam(POST)
  @ApiOkResponse(BODY)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async unschedulePost(
    @Call() context: CallContext,
    @Param('post') post: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'blog.unschedule-post-route',
      context,
      await this.unschedule.execute(context, { post }),
    );
  }

  @Post(':post/pause')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Take a published post off the site at once (admin)',
    description: 'Needs blog.post.pause. Body { reason }. No approval; the address answers 410.',
  })
  @ApiHeader(CSRF)
  @ApiParam(POST)
  @ApiBody(BODY)
  @ApiOkResponse(BODY)
  @ApiBadRequestResponse(BAD)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async pausePost(
    @Call() context: CallContext,
    @Param('post') post: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.body(request, body, ['reason']);
    return this.answer(
      'blog.pause-post-route',
      context,
      await this.pause.execute(context, { post, body }),
    );
  }

  @Post(':post/resume')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Put a paused post back on the site (admin)',
    description: 'Needs blog.post.publish. The live version it had comes back; no new review.',
  })
  @ApiHeader(CSRF)
  @ApiParam(POST)
  @ApiOkResponse(BODY)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async resumePost(
    @Call() context: CallContext,
    @Param('post') post: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'blog.resume-post-route',
      context,
      await this.resume.execute(context, { post }),
    );
  }

  @Post(':post/archive')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Archive a platform post (admin)',
    description: 'Needs blog.post.publish. The post leaves the site and its address answers 410.',
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
      'blog.archive-post-route',
      context,
      await this.archive.execute(context, { post }),
    );
  }

  @Put(':post/slug')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Change the address of a post that was published (admin)',
    description:
      'Needs blog.post.publish. Body { slug }. The old address redirects to the new one.',
  })
  @ApiHeader(CSRF)
  @ApiParam(POST)
  @ApiBody(BODY)
  @ApiOkResponse(BODY)
  @ApiBadRequestResponse(BAD)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async rename(
    @Call() context: CallContext,
    @Param('post') post: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.body(request, body, ['slug']);
    return this.answer(
      'blog.rename-slug-route',
      context,
      await this.renameSlug.execute(context, { post, body }),
    );
  }

  @Put(':post/featured')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Feature a published post, or not (admin)',
    description:
      'Needs blog.post.publish. Body { featured }. One post per Market is featured; two at once ' +
      'leave one featured and answer 409 conflict.stale to the other.',
  })
  @ApiHeader(CSRF)
  @ApiParam(POST)
  @ApiBody(BODY)
  @ApiOkResponse(BODY)
  @ApiBadRequestResponse(BAD)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async setFeatured(
    @Call() context: CallContext,
    @Param('post') post: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.body(request, body, ['featured']);
    return this.answer(
      'blog.feature-post-route',
      context,
      await this.feature.execute(context, { post, body }),
    );
  }

  @Put(':post/event-status')
  @HttpCode(200)
  @ApiOperation({
    summary: "Change an event's status at once (admin)",
    description:
      'Needs blog.post.edit. Body { status, message? }: scheduled, postponed, rescheduled or ' +
      'cancelled. Takes effect on the live post without a review, and is audited. A message is ' +
      'checked first (no outside link, no certification claim; 422 blog.checks-failed, also when ' +
      'the certification check cannot answer).',
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
      'blog.change-event-status-route',
      context,
      await this.eventStatus.execute(context, { post, body }),
    );
  }

  @Get(':post/copy-package')
  @ApiOperation({
    summary: 'The package that copies a post to another Market (admin)',
    description:
      'Needs blog.post.edit. The text of the post without its products, sellers, images, links, ' +
      'category and tags (they belong to this Market); the editor sends it with POST to the other ' +
      'Market, with copied: true, where it is a new draft. An event starts as scheduled.',
  })
  @ApiParam(POST)
  @ApiOkResponse(BODY)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse(NOT_FOUND)
  async copyPackage(
    @Call() context: CallContext,
    @Param('post') post: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'blog.prepare-post-copy-route',
      context,
      await this.copy.execute(context, { post }),
    );
  }
}
