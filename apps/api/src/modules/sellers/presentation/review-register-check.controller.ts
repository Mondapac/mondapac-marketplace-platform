import { Controller, Get, Logger, Param, Res } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ReviewRegisterCheckRead } from '../application/use-cases/review-register-check-read.use-case';
import { errorOf } from './my-file.answer';
import { SellersErrorBody } from './my-file.dto';
import { ReviewRegisterCheckBody } from './review-register-check.dto';

/**
 * The register state of a seller's file for a reviewer (sellers design 6.2, 7.7; slice 4a). A
 * thin adapter: the `CallContext` comes from `@Call()` and the admin session cookie of the
 * request's Market (`@RoutePopulation('admin')` with `@ReadsSession()`); the controller
 * authenticates only. The use case's gate decides who may read (`sellers.seller-file.review`), and the seller id of the path
 * is read with the request's Market, so a seller of another Market is `file.not-found`,
 * byte-identical to an unknown id (AC 1). The seller id is a UUID, not personal data; the answer
 * holds no business data and no register value, and is `no-store` all the same.
 */
@ApiTags('sellers')
@RoutePopulation('admin')
@ReadsSession()
@Controller('sellers/admin')
export class ReviewRegisterCheckController {
  readonly #logger = new Logger('ReviewRegisterCheckController');

  constructor(private readonly read: ReviewRegisterCheckRead) {}

  @Get(':sellerId/register-check')
  @ApiOperation({
    summary: 'The register state of a seller file (reviewer)',
    description:
      "Where the file's current business number stands against the official register: the " +
      'state, the mismatch flags, when and by whom it was last asked, and whether it blocks ' +
      'the submission or the approval. Never a register value. Needs sellers.seller-file.review.',
  })
  @ApiParam({ name: 'sellerId', description: 'The seller id (UUID).' })
  @ApiOkResponse({ type: ReviewRegisterCheckBody })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({
    type: SellersErrorBody,
    description: 'file.not-found (also for an id of another Market or a malformed id)',
  })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'access.unavailable' })
  async registerCheck(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReviewRegisterCheckBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.read.execute(context, { sellerId });
    this.#logger.log({
      msg: 'sellers.review-register-check-read',
      outcome: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw errorOf(result.error, response);
    return result.value;
  }
}
