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
import { CreateBlogCategory } from '../application/use-cases/create-category.use-case';
import { CreateBlogTag } from '../application/use-cases/create-tag.use-case';
import { DeleteBlogCategory } from '../application/use-cases/delete-category.use-case';
import { DeleteBlogTag } from '../application/use-cases/delete-tag.use-case';
import { ListBlogTaxonomy } from '../application/use-cases/list-taxonomy.use-case';
import { UpdateBlogCategory } from '../application/use-cases/update-category.use-case';
import { closedBody, plain, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const BODY = { type: Object };
const UNAUTHORIZED = { ...ERROR, description: 'access.unauthenticated or session.invalid' };
const FORBIDDEN = { ...ERROR, description: 'access.denied or request.csrf' };
const BAD = { ...ERROR, description: 'validation.failed (details.fields)' };

/** The categories and tags of the blog, for admins. Every answer is `Cache-Control: no-store`. */
@ApiTags('blog')
@RoutePopulation('admin')
@ReadsSession()
@Controller('blog/admin/taxonomy')
export class AdminBlogTaxonomyController {
  readonly #logger = new Logger('AdminBlogTaxonomyController');

  constructor(
    private readonly list: ListBlogTaxonomy,
    private readonly createCategory: CreateBlogCategory,
    private readonly updateCategory: UpdateBlogCategory,
    private readonly deleteCategory: DeleteBlogCategory,
    private readonly createTag: CreateBlogTag,
    private readonly deleteTag: DeleteBlogTag,
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
    summary: 'The categories and tags (admin)',
    description: 'Needs blog.post.read.',
  })
  @ApiOkResponse(BODY)
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async index(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'blog.list-taxonomy-route',
      context,
      await this.list.execute(context, undefined),
    );
  }

  @Post('categories')
  @ApiOperation({
    summary: 'Create a category (admin)',
    description:
      'Needs blog.taxonomy.edit. Body { slug, names: { locale: name }, position? }. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody(BODY)
  @ApiCreatedResponse(BODY)
  @ApiBadRequestResponse(BAD)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiConflictResponse({ ...ERROR, description: 'blog.category-slug-taken' })
  async postCategory(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.body(request, body, ['slug', 'names', 'position']);
    return this.answer(
      'blog.create-category-route',
      context,
      await this.createCategory.execute(context, { body }),
    );
  }

  @Put('categories/:category')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Change the names and position of a category (admin)',
    description:
      'Needs blog.taxonomy.edit. Body { names, position? }; the address never changes. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody(BODY)
  @ApiOkResponse(BODY)
  @ApiBadRequestResponse(BAD)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse({ ...ERROR, description: 'blog.category-not-found' })
  async putCategory(
    @Call() context: CallContext,
    @Param('category') category: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.body(request, body, ['names', 'position']);
    return this.answer(
      'blog.update-category-route',
      context,
      await this.updateCategory.execute(context, { category, body }),
    );
  }

  @Delete('categories/:category')
  @ApiOperation({
    summary: 'Delete a category (admin)',
    description: 'Needs blog.taxonomy.edit. Refused while a version uses it. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse(BODY)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse({ ...ERROR, description: 'blog.category-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'blog.category-in-use' })
  async removeCategory(
    @Call() context: CallContext,
    @Param('category') category: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'blog.delete-category-route',
      context,
      await this.deleteCategory.execute(context, { category }),
    );
  }

  @Post('tags')
  @ApiOperation({
    summary: 'Create a tag (admin)',
    description:
      'Needs blog.taxonomy.edit. Body { name, slug? }; the address is made from the name when not given. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody(BODY)
  @ApiCreatedResponse(BODY)
  @ApiBadRequestResponse(BAD)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiConflictResponse({ ...ERROR, description: 'blog.tag-slug-taken' })
  async postTag(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.body(request, body, ['name', 'slug']);
    return this.answer(
      'blog.create-tag-route',
      context,
      await this.createTag.execute(context, { body }),
    );
  }

  @Delete('tags/:tag')
  @ApiOperation({
    summary: 'Delete a tag (admin)',
    description: 'Needs blog.taxonomy.edit. Refused while a version uses it. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse(BODY)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse({ ...ERROR, description: 'blog.tag-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'blog.tag-in-use' })
  async removeTag(
    @Call() context: CallContext,
    @Param('tag') tag: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'blog.delete-tag-route',
      context,
      await this.deleteTag.execute(context, { tag }),
    );
  }
}
