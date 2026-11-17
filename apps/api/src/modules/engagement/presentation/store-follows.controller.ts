import { Controller, Delete, Get, HttpCode, Logger, Param, Put, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
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
import { MAX_FOLLOWS_PER_ACCOUNT, MAX_MY_STORES_PAGE } from '../domain/store-follow';
import { FollowStore } from '../application/use-cases/follow-store.use-case';
import { ListMyStores } from '../application/use-cases/list-my-stores.use-case';
import { UnfollowStore } from '../application/use-cases/unfollow-store.use-case';
import { ViewStoreFollow } from '../application/use-cases/view-store-follow.use-case';
import { MyStoresBody, StoreFollowBody, myStoresBody, storeFollowBody } from './engagement.dto';
import { logRoute, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const UNAUTHENTICATED = { ...ERROR, description: 'access.unauthenticated or session.invalid' };

/**
 * The signed-in customer's followed stores (customers management phase 3): follow and unfollow a
 * store, whether one store is followed, and "My stores". The customer comes from the session,
 * never from the request. Following again, or unfollowing a store not followed, changes nothing.
 * Every answer is `Cache-Control: no-store`.
 */
@ApiTags('engagement')
@RoutePopulation('customer')
@ReadsSession()
@Controller('customers/me/followed-stores')
export class StoreFollowsController {
  readonly #logger = new Logger('StoreFollowsController');

  constructor(
    private readonly follow: FollowStore,
    private readonly unfollow: UnfollowStore,
    private readonly view: ViewStoreFollow,
    private readonly list: ListMyStores,
  ) {}

  @Get()
  @ApiOperation({ summary: "The customer's followed stores, newest first" })
  @ApiQuery({ name: 'cursor', required: false, description: 'The `nextCursor` of the page before' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `1 to ${MAX_MY_STORES_PAGE}, default 50`,
  })
  @ApiOkResponse({ type: MyStoresBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHENTICATED)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'engagement.unavailable' })
  async index(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, { cursor, limit });
    this.log('engagement.list-my-stores-route', context, result.ok ? 'read' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return myStoresBody(result.value);
  }

  @Get(':sellerId')
  @ApiOperation({ summary: 'Whether the customer follows one store' })
  @ApiOkResponse({ type: StoreFollowBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHENTICATED)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async show(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('sellerId') sellerId: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { sellerId });
    this.log('engagement.view-store-follow-route', context, result.ok ? 'read' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return storeFollowBody(result.value);
  }

  @Put(':sellerId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Follow a store',
    description:
      `Only a store the public can see now. At most ${MAX_FOLLOWS_PER_ACCOUNT} stores. ` +
      'The seller sees the follower as its own customer code and first name only.',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: StoreFollowBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHENTICATED)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'engagement.store-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'engagement.follow-limit' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'engagement.unavailable' })
  async put(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('sellerId') sellerId: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.follow.execute(context, { sellerId });
    this.log('engagement.follow-store-route', context, result.ok ? 'followed' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return storeFollowBody(result.value);
  }

  @Delete(':sellerId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop following a store' })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: StoreFollowBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHENTICATED)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  async remove(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('sellerId') sellerId: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.unfollow.execute(context, { sellerId });
    this.log(
      'engagement.unfollow-store-route',
      context,
      result.ok ? 'unfollowed' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return storeFollowBody(result.value);
  }

  private log(msg: string, context: CallContext, outcome: string): void {
    logRoute(this.#logger, msg, context, outcome);
  }
}
