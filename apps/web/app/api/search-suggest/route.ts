import { loadSuggestions } from '../../../src/storefront/source.ts';
import { QUERY_MIN, queryOf } from '../../../src/storefront/catalog.ts';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * The header search's suggestions (search package 1b): `GET /api/search-suggest?q=`. The browser
 * asks here and never the API, so the Market, the client address and the photo origin stay on
 * the server (all reads go through storefront/source.ts). 400 for fewer than 2 characters, 502
 * when there is no answer; the panel treats any non-200 as "could not load" and search goes on.
 */
export async function GET(request: Request) {
  const q = queryOf(new URL(request.url).searchParams.get('q') ?? undefined);
  if (Array.from(q).length < QUERY_MIN) {
    return Response.json({ code: 'validation.failed' }, { status: 400, headers: NO_STORE });
  }
  const read = await loadSuggestions(q);
  if (read.kind !== 'ok') {
    // A rate limit is passed on so the browser backs off; no other cause or text goes out.
    // (The API read does not hand back Retry-After, so none is sent.)
    const limited = read.status === 429;
    return Response.json(
      { code: limited ? 'rate-limited' : 'search.unavailable' },
      { status: limited ? 429 : 502, headers: NO_STORE },
    );
  }
  return Response.json(read.answer, { headers: NO_STORE });
}
