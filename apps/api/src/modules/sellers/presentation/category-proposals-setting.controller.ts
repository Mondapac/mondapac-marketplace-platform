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
import { ChangeCategoryProposalsUseCase } from '../application/use-cases/change-category-proposals.use-case';
import { errorOf, fail } from './my-file.answer';
import { SellersErrorBody } from './my-file.dto';

export class CategoryProposalsRequest {
  @ApiProperty({ description: 'Whether the seller may propose categories (SEL-26).' })
  allowed!: boolean;
}

export class CategoryProposalsBody {
  @ApiProperty()
  allowed!: boolean;

  @ApiProperty({ description: 'False when the switch already held the value.' })
  changed!: boolean;
}

/**
 * The category-proposals switch of a seller (SEL-26), for an admin with
 * `sellers.seller-settings.edit`. A thin adapter: the `CallContext` comes from `@Call()` and the
 * admin session cookie of the request's Market; an unsafe request also needs `Origin` on the
 * Market's admin list, `Sec-Fetch-Site: same-origin` and the CSRF header. Who may do it is the use
 * case's gate. The body is JSON only and closed; the answer is `Cache-Control: no-store`.
 */
@ApiTags('sellers')
@RoutePopulation('admin')
@ReadsSession()
@Controller('sellers/admin')
export class CategoryProposalsSettingController {
  readonly #logger = new Logger('CategoryProposalsSettingController');

  constructor(private readonly change: ChangeCategoryProposalsUseCase) {}

  @Put(':sellerId/category-proposals')
  @ApiOperation({
    summary: 'Allow or stop category proposals for a seller (admin)',
    description:
      'Off by default. Turning it on raises sellers.category-proposals-granted.v1 and turning ' +
      'it off raises sellers.category-proposals-revoked.v1 for catalog to act on. Needs ' +
      'sellers.seller-settings.edit.',
  })
  @ApiParam({ name: 'sellerId', description: 'The seller id (UUID).' })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: CategoryProposalsRequest })
  @ApiOkResponse({ type: CategoryProposalsBody })
  @ApiBadRequestResponse({ type: SellersErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'request.csrf or access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiUnsupportedMediaTypeResponse({ type: SellersErrorBody, description: 'Not application/json' })
  async putCategoryProposals(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<CategoryProposalsBody> {
    response.setHeader('Cache-Control', 'no-store');
    if (request.is('application/json') !== 'application/json') {
      throw fail(415, 'request.body-unsupported');
    }
    const result = await this.change.execute(context, { sellerId, body });
    this.#logger.log({
      msg: 'sellers.category-proposals-set',
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw errorOf(result.error, response);
    return result.value;
  }
}
