import { Controller, Get, HttpCode, Logger, Param, Post, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
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
import { CountOwnUnreadNotices } from '../application/use-cases/count-own-unread-notices.use-case';
import { ListOwnNotices } from '../application/use-cases/list-own-notices.use-case';
import { MarkOwnNoticesRead } from '../application/use-cases/mark-own-notices-read.use-case';
import { refusal } from './http-answers';
import { NoticePageBody, NoticesMarkedBody, UnreadNoticesBody } from './notices.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

/**
 * The signed-in admin's in-app notices (in-app notifications package 3): the admin bell's count,
 * the list, and marking them read. The same own-resources use cases as the seller routes; the
 * Market and the account come from the session, and each kind is shown only to an admin holding
 * the permission of its review queue. Every answer is `Cache-Control: no-store`. Logs ids and
 * codes only.
 */
@ApiTags('notifications')
@RoutePopulation('admin')
@ReadsSession()
@Controller('notifications/admin/notices')
export class AdminNoticesController {
  readonly #logger = new Logger('AdminNoticesController');

  constructor(
    private readonly list: ListOwnNotices,
    private readonly count: CountOwnUnreadNotices,
    private readonly mark: MarkOwnNoticesRead,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The admin notices of the signed-in admin, newest first',
    description:
      'Each kind is listed only while the admin holds its permission (admin.seller-certificate-submitted: certification.seller-certificate.review; admin.product-revision-submitted: catalog.product.approve; admin.seller-file-submitted: sellers.seller-file.review; admin.price-hold-opened: pricing.price-hold.decide). Kept 90 days. customerShortName is always null.',
  })
  @ApiQuery({ name: 'before', required: false, description: 'The `next` of the previous page.' })
  @ApiQuery({
    name: 'show',
    required: false,
    enum: ['unread', 'read', 'all'],
    description: 'Default unread.',
  })
  @ApiOkResponse({ type: NoticePageBody })
  @ApiBadRequestResponse({
    ...ERROR,
    description: 'validation.failed (details.fields: before or show)',
  })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async page(
    @Call() context: CallContext,
    @Query('before') before: unknown,
    @Query('show') show: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, {
      ...(before === undefined ? {} : { before }),
      ...(show === undefined ? {} : { show }),
    });
    this.log(
      'notifications.admin-list-notices-route',
      context,
      result.ok ? 'listed' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Get('unread-count')
  @ApiOperation({
    summary: 'The unread count for the bell, and the newest unread notice',
    description: 'What the admin panel polls. Same scope as the list.',
  })
  @ApiOkResponse({ type: UnreadNoticesBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async unread(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.count.execute(context, {});
    this.log(
      'notifications.admin-count-notices-route',
      context,
      result.ok ? 'counted' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Mark every notice the admin may see as read (for this admin only)',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: NoticesMarkedBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async readAll(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.mark.execute(context, { target: { all: true } });
    this.log(
      'notifications.admin-read-all-notices-route',
      context,
      result.ok ? 'marked' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Post(':noticeId/read')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Mark one notice as read (for this admin only)',
    description: 'Opening a notice in the panel marks it read. Marking it again changes nothing.',
  })
  @ApiParam({ name: 'noticeId', format: 'uuid' })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: NoticesMarkedBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields: id)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({
    ...ERROR,
    description: 'notifications.notice-not-found (unknown, or not one this admin may see)',
  })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async readOne(
    @Call() context: CallContext,
    @Param('noticeId') noticeId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.mark.execute(context, { target: { id: noticeId } });
    this.log(
      'notifications.admin-read-notice-route',
      context,
      result.ok ? 'marked' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  private log(msg: string, context: CallContext, outcome: string): void {
    this.#logger.log({
      msg,
      outcome,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
