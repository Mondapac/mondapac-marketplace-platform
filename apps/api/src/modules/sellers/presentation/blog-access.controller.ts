import { Body, Controller, Logger, Param, Put, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiPropertyOptional,
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
import { BlogAccessSetUseCase } from '../application/use-cases/blog-access-set.use-case';
import { errorOf, fail } from './my-file.answer';
import { SellersErrorBody } from './my-file.dto';

export class BlogAccessRequest {
  @ApiProperty({ description: 'Whether the seller may write blog posts.' })
  enabled!: boolean;

  @ApiPropertyOptional({
    description: 'With enabled: false, also take the seller live posts off the site.',
  })
  unpublishLive?: boolean;
}

export class BlogAccessBody {
  @ApiProperty()
  enabled!: boolean;

  @ApiProperty({ description: 'False when the switch already held the value.' })
  changed!: boolean;
}

/**
 * The blog switch of a seller (blog package 1), for a Platform Administrator. A thin adapter: the
 * `CallContext` comes from `@Call()` and the admin session cookie of the request's Market; an
 * unsafe request also needs `Origin` on the Market's admin list, `Sec-Fetch-Site: same-origin` and
 * the CSRF header. Who may do it is the use case's gate (`sellers.blog-access.edit`, protected).
 * The body is JSON only and closed; the answer is `Cache-Control: no-store`.
 */
@ApiTags('sellers')
@RoutePopulation('admin')
@ReadsSession()
@Controller('sellers/admin')
export class BlogAccessController {
  readonly #logger = new Logger('BlogAccessController');

  constructor(private readonly setAccess: BlogAccessSetUseCase) {}

  @Put(':sellerId/blog-access')
  @ApiOperation({
    summary: "Switch a seller's blog access on or off (admin)",
    description:
      'Off by default. Turning it off keeps the posts; with unpublishLive the live posts of the ' +
      'seller also come off the site. Needs sellers.blog-access.edit (Platform Administrator).',
  })
  @ApiParam({ name: 'sellerId', description: 'The seller id (UUID).' })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: BlogAccessRequest })
  @ApiOkResponse({ type: BlogAccessBody })
  @ApiBadRequestResponse({ type: SellersErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'request.csrf or access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiUnsupportedMediaTypeResponse({ type: SellersErrorBody, description: 'Not application/json' })
  async putBlogAccess(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<BlogAccessBody> {
    response.setHeader('Cache-Control', 'no-store');
    if (request.is('application/json') !== 'application/json') {
      throw fail(415, 'request.body-unsupported');
    }
    const result = await this.setAccess.execute(context, { sellerId, body });
    this.#logger.log({
      msg: 'sellers.blog-access-set',
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw errorOf(result.error, response);
    return result.value;
  }
}
