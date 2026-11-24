import type { Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { writeChunks, type ExportFile } from '../../../platform/list-export';
import type { DailyExportFailure } from '../application/use-cases/export-seller-daily.use-case';

/** Query parameters of both daily exports, for OpenAPI. */
export const DAILY_EXPORT_QUERY = {
  period: {
    name: 'period',
    required: false,
    enum: ['today', '7d', '30d', 'month', 'custom'],
  },
  from: {
    name: 'from',
    required: false,
    description: 'First Market day (YYYY-MM-DD) of a custom range; with `to`, at most 13 months.',
  },
  to: {
    name: 'to',
    required: false,
    description: "Last Market day (YYYY-MM-DD) of a custom range, not after the Market's today.",
  },
  format: { name: 'format', required: false, enum: ['csv', 'xlsx'] },
} as const;

/**
 * Sends a daily export: a refusal as the usual JSON error (`validation.failed` with
 * `details.fields`), or the file as an attachment that streams with backpressure. A failure after
 * the status line ends the connection, so the client sees a failed download, never a short file.
 * Logs codes, the period kind and the row count only, never a figure.
 */
export async function sendDailyExport(
  result: Result<ExportFile, DailyExportFailure>,
  context: CallContext,
  response: Response,
  logger: Logger,
  msg: string,
): Promise<void> {
  response.setHeader('Cache-Control', 'no-store');
  const base = { msg, marketId: context.market.marketId, correlationId: context.correlationId };
  if (!result.ok) {
    logger.log({ ...base, outcome: result.error.code });
    if (result.error.code === 'validation.failed') {
      response.status(400).json({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: result.error.fields },
      });
      return;
    }
    const status = ACCESS_DENIED_STATUS[result.error.code];
    response.status(status).json({ statusCode: status, code: result.error.code });
    return;
  }
  const { filename, contentType, chunks } = result.value;
  logger.log({ ...base, outcome: 'ok', filename });
  response.status(200);
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    await writeChunks(response, chunks);
  } catch {
    logger.warn({ ...base, outcome: 'stream-failed' });
    response.destroy();
  }
}
