import { HttpException } from '@nestjs/common';
import type { ShelfRequest } from '../domain/shelf-query';

const WHOLE_NUMBER = /^[0-9]{1,6}$/u;

export const fail = (status: number, code: string, details?: object): HttpException =>
  new HttpException({ statusCode: status, code, ...(details ? { details } : {}) }, status);

/**
 * The query string of a shelf route as a shelf request: only the `allowed` names are read; an
 * unknown name, a repeated or non-text value and a `limit` that is not a whole number are
 * `validation.failed` (400) with the field paths (never the values).
 */
export function shelfRequestOf(
  query: Record<string, unknown>,
  allowed: readonly ('category' | 'limit')[],
): ShelfRequest {
  const fields = Object.keys(query)
    .filter((key) => !(allowed as readonly string[]).includes(key))
    .sort()
    .slice(0, 10)
    .map((key) => ({
      path: Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�'),
      code: 'unknown-field',
    }));
  const text = (name: 'category' | 'limit'): string | undefined => {
    const value = query[name];
    if (value === undefined || !allowed.includes(name)) return undefined;
    if (typeof value !== 'string') {
      fields.push({ path: name, code: 'type' });
      return undefined;
    }
    return value;
  };
  const category = text('category');
  const limitText = text('limit');
  let limit: number | undefined;
  if (limitText !== undefined) {
    if (WHOLE_NUMBER.test(limitText)) limit = Number(limitText);
    else fields.push({ path: 'limit', code: 'range' });
  }
  if (fields.length > 0) throw fail(400, 'validation.failed', { fields });
  return { category, limit };
}
