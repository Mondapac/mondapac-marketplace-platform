import { loadStoreImage } from '../../../../../../src/storefront/source.ts';

// A store's logo or banner (`/s/<slug>/images/<id>/<small|large>`): the buyer site asks the API
// (`sellers/stores/:slug/images/:id/:size`) and passes the JPEG on, so the browser never needs the
// API's address. Only the picture the API names is served, as an image the API wrote; anything
// else is one plain 404. A fault is a 503 that nothing caches.

export const dynamic = 'force-dynamic';

interface Context {
  readonly params: Promise<{ slug: string; imageId: string; size: string }>;
}

const HEADERS = {
  'content-type': 'image/jpeg',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
} as const;

export async function GET(_request: Request, context: Context): Promise<Response> {
  const { slug, imageId, size } = await context.params;
  const read = await loadStoreImage(slug, imageId, size);
  if (read.kind === 'ok') {
    return new Response(read.bytes as BodyInit, {
      headers: { ...HEADERS, 'cache-control': 'public, max-age=300' },
    });
  }
  return new Response(null, {
    status: read.kind === 'none' ? 404 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}
