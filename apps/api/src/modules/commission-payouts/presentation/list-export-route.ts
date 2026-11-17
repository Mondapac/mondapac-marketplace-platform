import type { Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { writeChunks, type ExportFile } from '../../../platform/list-export';
import { parseLimit, refusal } from './http-answers';

/** The paging numbers of a list query, as numbers (the query string carries text). */
export function numbersOf(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...query };
  for (const key of ['page', 'pageSize', 'limit']) {
    if (out[key] !== undefined) out[key] = parseLimit(out[key]);
  }
  return out;
}

/**
 * Answers an export use case: the refusal as JSON, or the file as an attachment streamed in
 * chunks (no-store, nosniff). A stream that fails after the status line ends the connection.
 */
export async function sendExport<E extends { readonly code: string }>(
  response: Response,
  result: Result<ExportFile, E>,
  context: CallContext,
  logger: Logger,
  msg: string,
): Promise<void> {
  logger.log({
    msg,
    outcome: result.ok ? 'export' : result.error.code,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  if (!result.ok) {
    const error = refusal(result.error, context, logger);
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
    logger.warn({
      msg,
      code: 'stream-failed',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    response.destroy();
  }
}
