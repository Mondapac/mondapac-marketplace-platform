// The sitemap routes' three answers. Never cached: whether a sitemap exists follows the indexing
// switch, which is read per request.

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export const xmlResponse = (body: string): Response =>
  new Response(body, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', ...NO_STORE },
  });

export const notFoundResponse = (): Response =>
  new Response('Not found', { status: 404, headers: NO_STORE });

/** A read failed: 503 so the crawler retries later; an empty sitemap would say "no pages". */
export const unavailableResponse = (): Response =>
  new Response('Unavailable', { status: 503, headers: { ...NO_STORE, 'Retry-After': '300' } });
