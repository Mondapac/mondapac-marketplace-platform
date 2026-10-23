import type { Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS, type AccessDenied } from '../../../platform/authz';
import { recentViewsRequestOf } from '../../engagement';
import type {
  PersonalShelf,
  PersonalShelfFailure,
  PersonalShelfInput,
} from '../application/use-cases/list-for-you.use-case';
import type { ShelfPageBody } from './search.dto';
import { fail, shelfRequestOf } from './shelf-request';

type Run = (
  context: CallContext,
  input: PersonalShelfInput,
) => Promise<Result<PersonalShelf, PersonalShelfFailure | AccessDenied>>;

/**
 * The shared body of the two personal shelf routes. Every answer is `no-store`, an error one too,
 * and no cookie is set, extended or cleared: these routes only read. Who the shopper is comes from
 * the session (the context's actor) or the engagement guest cookie, never from the query; the
 * query allows `limit` only. The cookie, the `Sec-GPC` and the `Engagement-Consent` headers go
 * to the use case as they are and are never logged.
 */
export async function personalShelf(
  context: CallContext,
  request: Request,
  response: Response,
  query: Record<string, unknown>,
  forCustomer: Run,
  forGuest: Run,
  logger: Logger,
  route: string,
): Promise<ShelfPageBody> {
  response.setHeader('Cache-Control', 'no-store');
  const { limit } = shelfRequestOf(query, ['limit']);
  const input: PersonalShelfInput = {
    limit,
    privacy: recentViewsRequestOf(request.headers, context.market.marketId),
  };
  const result = await (context.actor.kind === 'authenticated' ? forCustomer : forGuest)(
    context,
    input,
  );
  if (result.ok) return JSON.parse(JSON.stringify(result.value)) as ShelfPageBody;
  const { error } = result;
  if (error.code === 'validation.failed') throw fail(400, error.code, { fields: error.fields });
  const denied = ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
  if (denied !== undefined) throw fail(denied, error.code);
  logger.warn({
    msg: route,
    code: error.code,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  throw fail(503, 'search.unavailable');
}
