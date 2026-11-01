import { loadReviewsPage } from '../../../../src/reviews/reviews-source.ts';

export const dynamic = 'force-dynamic';

const CURSOR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HEADERS = { 'cache-control': 'no-store' } as const;

/**
 * One page of a product's published reviews for the product page ("Show more" and the star
 * filter). Public, no session; read through the same server-side read as the page, so the API's
 * origin and rate-limit identity stay on the server. Only two query values pass, each checked.
 * "Off or nothing to show" is a 404; a throttled or failed read is 429 or 503, so a client can
 * back off.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const query = new URL(request.url).searchParams;
  const starsText = query.get('stars');
  const cursor = query.get('cursor');
  const stars = starsText === null ? undefined : Number(starsText);
  if (stars !== undefined && !(Number.isInteger(stars) && stars >= 1 && stars <= 5)) {
    return Response.json({ code: 'validation.failed' }, { status: 400, headers: HEADERS });
  }
  if (cursor !== null && !CURSOR.test(cursor)) {
    return Response.json({ code: 'validation.failed' }, { status: 400, headers: HEADERS });
  }
  const read = await loadReviewsPage(id, {
    ...(stars === undefined ? {} : { stars }),
    ...(cursor === null ? {} : { cursor: cursor.toLowerCase() }),
  });
  if (read.kind === 'ok') return Response.json(read.page, { headers: HEADERS });
  if (read.kind === 'off') {
    return Response.json({ code: 'reviews.disabled' }, { status: 404, headers: HEADERS });
  }
  if (read.kind === 'throttled') {
    return Response.json(
      { code: 'request.throttled' },
      { status: 429, headers: { ...HEADERS, 'retry-after': '30' } },
    );
  }
  return Response.json({ code: 'reviews.unavailable' }, { status: 503, headers: HEADERS });
}
