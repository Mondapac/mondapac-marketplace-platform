import type { Response } from 'express';

/**
 * Streams the chunks of an export to the response, with backpressure, and stops as soon as the
 * client goes away (a closed tab or a dropped connection): the source is then closed through the
 * loop's `break` (an async generator runs its `finally`), so no producer keeps working for a socket
 * nobody reads. Returns `false` when the client left before the end, `true` after `end()`.
 */
export async function writeChunks(
  response: Pick<Response, 'write' | 'end' | 'once' | 'off' | 'destroyed'>,
  chunks: AsyncIterable<string | Uint8Array>,
): Promise<boolean> {
  let gone = response.destroyed;
  const onClose = (): void => {
    gone = true;
  };
  response.once('close', onClose);
  // Waits until the socket drains, or until the client leaves or the socket fails.
  const drained = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const done = (): void => {
        response.off('drain', done);
        response.off('close', done);
        response.off('error', done);
        resolve();
      };
      response.once('drain', done);
      response.once('close', done);
      response.once('error', done);
    });
  try {
    for await (const chunk of chunks) {
      if (gone) break;
      if (!response.write(chunk)) await drained();
      if (gone) break;
    }
    if (gone) return false;
    response.end();
    return true;
  } finally {
    response.off('close', onClose);
  }
}
