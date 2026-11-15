import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
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
  ApiUnprocessableEntityResponse,
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
import { CategoryProposalApprove } from '../application/use-cases/category-proposal-approve.use-case';
import { CategoryProposalList } from '../application/use-cases/category-proposal-list.use-case';
import { CategoryProposalReject } from '../application/use-cases/category-proposal-reject.use-case';
import { SellerCategoryAdminList } from '../application/use-cases/seller-category-admin-list.use-case';
import { SellerCategoryMerge } from '../application/use-cases/seller-category-merge.use-case';
import { SellerCategoryPromote } from '../application/use-cases/seller-category-promote.use-case';
import { closedBody, pageQuery, refusalWith, type Refusal } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';
import {
  ProposalDecidedBody,
  ProposalQueueBody,
  ProposalRejectRequest,
  ProposalVersionRequest,
  ShelfListBody,
  ShelfMergedBody,
  ShelfMergeRequest,
  ShelfPromotedBody,
  ShelfPromoteRequest,
} from './seller-category.dto';

/**
 * The HTTP status of each refusal of the admin proposal and shelf routes (categories C9a). A
 * malformed request is 400; a seller whose proposal permission is off is 403; an unknown
 * proposal, shelf, parent or target category is 404; a decided proposal, a closed shelf, a
 * duplicate, a taken slug or name, or a stale version is 409; a claim word, an uncheckable locale
 * or a level past the Market's depth is 422; a missing dependency is 503.
 */
export const CATEGORY_PROPOSAL_ADMIN_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'category-proposal.not-allowed': 403,
  'category-proposal.not-found': 404,
  'seller-category.not-found': 404,
  'category.parent-not-found': 404,
  'category.not-found': 404,
  'category-proposal.not-pending': 409,
  'category-proposal.duplicate': 409,
  'seller-category.not-active': 409,
  'category.slug-taken': 409,
  'category.sibling-name-taken': 409,
  'conflict.stale': 409,
  'category.depth-exceeded': 422,
  'category.required-locale-missing': 422,
  'category.claim-word': 422,
  'category.locale-uncheckable': 422,
  'claim-text.check-unavailable': 503,
  'access.unavailable': 503,
});

const refusal = (error: Refusal, response: Response, context?: CallContext): HttpException =>
  refusalWith(
    CATEGORY_PROPOSAL_ADMIN_STATUS,
    error,
    response,
    context,
    'catalog.category-proposal-admin-unmapped-refusal',
  );

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const PROPOSAL_PARAM = { name: 'proposalId', description: 'The proposal. A UUID v7.' };
const SHELF_PARAM = { name: 'shelfId', description: 'The seller shelf. A UUID v7.' };

/**
 * Seller category proposals and shelves for admins (categories C9a; CAT-52, CAT-53; ux FP8 row 4).
 * The admin session of the request's Market is read (`@ReadsSession`), so a write needs the CSRF
 * token and the admin panel's origin; JSON only, closed bodies. Approve, reject and the reads need
 * `catalog.category-proposal.decide`; promote and merge the protected
 * `catalog.seller-category.promote-merge`. None works from an acting-as session.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin')
export class CategoryProposalAdminController {
  readonly #logger = new Logger('CategoryProposalAdminController');

  constructor(
    private readonly queue: CategoryProposalList,
    private readonly approveProposal: CategoryProposalApprove,
    private readonly rejectProposal: CategoryProposalReject,
    private readonly shelvesOf: SellerCategoryAdminList,
    private readonly promoteShelf: SellerCategoryPromote,
    private readonly mergeShelf: SellerCategoryMerge,
  ) {}

  @Get('category-proposals')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List waiting category proposals',
    description:
      'Needs catalog.category-proposal.decide. Oldest first, keyset-paged: send `nextAfterId` as ' +
      '`afterId`. `limit` is 1 to 50 (default 25).',
  })
  @ApiQuery({ name: 'afterId', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ type: ProposalQueueBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<ProposalQueueBody> {
    const result = await this.queue.execute(context, pageQuery(query));
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as ProposalQueueBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.category-proposal-list', context, outcome);
  }

  @Post('category-proposals/:proposalId/approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Approve a category proposal',
    description:
      'Needs catalog.category-proposal.decide. Creates a shelf of the seller’s shop under the ' +
      'proposal’s parent; never a platform category. Refused when the seller’s proposal ' +
      'permission is off now (category-proposal.not-allowed).',
  })
  @ApiParam(PROPOSAL_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: ProposalVersionRequest })
  @ApiOkResponse({ type: ProposalDecidedBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, request.csrf or category-proposal.not-allowed',
  })
  @ApiNotFoundResponse({
    type: ApiErrorBody,
    description: 'category-proposal.not-found or category.parent-not-found',
  })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'category-proposal.not-pending, category-proposal.duplicate or conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async approve(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
  ): Promise<ProposalDecidedBody> {
    const input = closedBody(request, body, ['version']);
    let outcome: ProposalDecidedBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.approveProposal.execute(context, { proposalId, body: input });
      outcome = result.ok ? { ...result.value } : refusal(result.error, response, context);
    }
    return this.settle('catalog.category-proposal-approve', context, outcome);
  }

  @Post('category-proposals/:proposalId/reject')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Reject a category proposal',
    description: 'Needs catalog.category-proposal.decide. A prepared reason code, never text.',
  })
  @ApiParam(PROPOSAL_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: ProposalRejectRequest })
  @ApiOkResponse({ type: ProposalDecidedBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'category-proposal.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'category-proposal.not-pending or conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async reject(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
  ): Promise<ProposalDecidedBody> {
    const input = closedBody(request, body, ['version', 'reasonCode']);
    let outcome: ProposalDecidedBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.rejectProposal.execute(context, { proposalId, body: input });
      outcome = result.ok ? { ...result.value } : refusal(result.error, response, context);
    }
    return this.settle('catalog.category-proposal-reject', context, outcome);
  }

  @Get('sellers/:sellerId/shelves')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List one seller’s shelves',
    description:
      'Needs catalog.category-proposal.decide. Every status, active first; an unknown seller ' +
      'answers an empty list.',
  })
  @ApiParam({ name: 'sellerId', description: 'The seller. A UUID v7.' })
  @ApiOkResponse({ type: ShelfListBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async shelves(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('sellerId') sellerId: string,
  ): Promise<ShelfListBody> {
    const result = await this.shelvesOf.execute(context, { sellerId });
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as ShelfListBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.seller-category-admin-list', context, outcome);
  }

  @Post('shelves/:shelfId/promote')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Promote a shelf into the platform tree',
    description:
      'Needs the protected catalog.seller-category.promote-merge. The shelf becomes a platform ' +
      'category with the same id under its parent, created hidden; the tree rules of an add apply ' +
      '(depth, sibling names, a free slug, the claim-text check). The shelf leaves the seller’s ' +
      'Offers. No published revision changes.',
  })
  @ApiParam(SHELF_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: ShelfPromoteRequest })
  @ApiOkResponse({ type: ShelfPromotedBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({
    type: ApiErrorBody,
    description: 'seller-category.not-found or category.parent-not-found',
  })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'seller-category.not-active, category.slug-taken, category.sibling-name-taken or conflict.stale',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description:
      'category.depth-exceeded (details.max), category.claim-word or category.locale-uncheckable',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or claim-text.check-unavailable',
  })
  async promote(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('shelfId') shelfId: string,
    @Body() body: unknown,
  ): Promise<ShelfPromotedBody> {
    const input = closedBody(request, body, ['version', 'slug', 'treeVersion']);
    let outcome: ShelfPromotedBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.promoteShelf.execute(context, { shelfId, body: input });
      outcome = result.ok ? { ...result.value } : refusal(result.error, response, context);
    }
    return this.settle('catalog.seller-category-promote', context, outcome);
  }

  @Post('shelves/:shelfId/merge')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Merge a shelf into a platform category',
    description:
      'Needs the protected catalog.seller-category.promote-merge. Terminal: the shelf closes and ' +
      'is cleared on the seller’s Offers (not moved: a platform category is never a shelf). ' +
      'Shelves are not platform categories; add the category to the products through a revision.',
  })
  @ApiParam(SHELF_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: ShelfMergeRequest })
  @ApiOkResponse({ type: ShelfMergedBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({
    type: ApiErrorBody,
    description: 'seller-category.not-found or category.not-found',
  })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'seller-category.not-active or conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async merge(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('shelfId') shelfId: string,
    @Body() body: unknown,
  ): Promise<ShelfMergedBody> {
    const input = closedBody(request, body, ['version', 'categoryId']);
    let outcome: ShelfMergedBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.mergeShelf.execute(context, { shelfId, body: input });
      outcome = result.ok ? { ...result.value } : refusal(result.error, response, context);
    }
    return this.settle('catalog.seller-category-merge', context, outcome);
  }

  private settle<T extends object>(
    msg: string,
    context: CallContext,
    outcome: T | HttpException,
  ): T {
    const failed = outcome instanceof HttpException && outcome.getStatus() >= 500;
    this.#logger[failed ? 'warn' : 'log']({
      msg,
      outcome:
        outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
