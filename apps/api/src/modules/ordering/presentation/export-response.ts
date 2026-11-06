import type { Logger } from '@nestjs/common';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { refusal } from './http-answers';
import { writeChunks } from './write-chunks';

/** The file an order export hands to the route: its name, its type and its chunks of text. */
interface ExportFile {
  readonly filename: string;
  readonly contentType: string;
  readonly chunks: AsyncIterable<string>;
}

/**
 * Sends an order export: the refusal as the usual JSON error, or the file as an attachment that
 * streams with backpressure. A failure after the status line ends the connection, so the client
 * sees a failed download, never a short file that looks whole.
 */
export async function sendOrdersExport(
  result:
    | { readonly ok: true; readonly value: ExportFile }
    | { readonly ok: false; readonly error: { readonly code: string } & Record<string, unknown> },
  context: CallContext,
  response: Response,
  logger: Logger,
  msg: string,
): Promise<void> {
  response.setHeader('Cache-Control', 'no-store');
  if (!result.ok) {
    const error = refusal(result.error, context, logger);
    response.status(error.getStatus()).json(error.getResponse());
    return;
  }
  const { filename, contentType, chunks } = result.value;
  response.status(200);
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
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
