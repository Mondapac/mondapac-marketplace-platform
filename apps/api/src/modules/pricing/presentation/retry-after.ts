import type { HttpException } from '@nestjs/common';
import type { Response } from 'express';

/** A 429 carries its wait in `Retry-After` as well as in `details`, as the platform rate-limit guard does. */
export function setRetryAfter(response: Response, outcome: HttpException): void {
  if (outcome.getStatus() !== 429) return;
  const body = outcome.getResponse() as { details?: { retryAfterSeconds?: number } };
  const seconds = body.details?.retryAfterSeconds;
  if (seconds !== undefined) response.setHeader('Retry-After', String(seconds));
}
