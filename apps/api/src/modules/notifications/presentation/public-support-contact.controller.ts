import { Controller, Get, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { ViewPublicSupportContact } from '../application/use-cases/view-public-support-contact.use-case';
import { PublicSupportContactBody } from './support-contact.dto';

/**
 * The Market's support email for the sign-in pages of both panels. No session is read: the actor
 * is the Market's anonymous actor, and the answer holds the address only. A safe GET, so the
 * population only names the allow-list an unsafe request would use (none here).
 */
@ApiTags('notifications')
@RoutePopulation('admin')
@Controller('notifications/support-contact')
export class PublicSupportContactController {
  constructor(private readonly view: ViewPublicSupportContact) {}

  @Get()
  @ApiOperation({
    summary: 'The support email address (public)',
    description: 'No session needed. email is null when the Market has none.',
  })
  @ApiOkResponse({ type: PublicSupportContactBody })
  async one(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    // The use case cannot fail: its error type is never.
    return result.ok ? result.value : { email: null };
  }
}
