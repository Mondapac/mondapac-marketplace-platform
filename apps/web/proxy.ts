import { NextResponse } from 'next/server';
import { NOINDEX_HEADER, indexingOn } from './src/seo/indexing.ts';

/**
 * Adds `X-Robots-Tag: noindex, nofollow` to every response, files included, while indexing is off.
 * It runs per request, so the switch takes effect without a rebuild (next.config headers are fixed
 * at build). It changes no request header.
 */
export function proxy(): NextResponse {
  const response = NextResponse.next();
  if (!indexingOn()) response.headers.set(NOINDEX_HEADER.name, NOINDEX_HEADER.value);
  return response;
}
