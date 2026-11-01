import { loadReviewsPage } from '../../../../src/reviews/reviews-source.ts';

export const dynamic = 'force-dynamic';

const CURSOR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * One page of a product's published reviews for the product page ("Show more" and the star
 * filter). Public, no session; read through the same server-side read as the page, so the API's
 * origin and rate-limit identity stay on the server. Only two query values pass, each checked.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const query = new URL(request.url).searchParams;
  const starsText = query.get('stars');
  const cursor = query.get('cursor');
  const stars = starsText === null ? undefined : Number(starsText);
  if (stars !== undefined && !(Number.isInteger(stars) && stars >= 1 && stars <= 5)) {
    return Response.json({ code: 'validation.failed' }, { status: 400 });
  }
  if (cursor !== null && !CURSOR.test(cursor)) {
    return Response.json({ code: 'validation.failed' }, { status: 400 });
  }
  const page = await loadReviewsPage(id, {
    ...(stars === undefined ? {} : { stars }),
    ...(cursor === null ? {} : { cursor: cursor.toLowerCase() }),
  });
  if (page === null) return Response.json({ code: 'reviews.unavailable' }, { status: 404 });
  return Response.json(page, { headers: { 'cache-control': 'no-store' } });
}
