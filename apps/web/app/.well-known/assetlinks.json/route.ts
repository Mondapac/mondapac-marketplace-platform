import { assetLinks } from '../../../src/pwa/asset-links.ts';

// Read per request so a key change needs no rebuild.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json(assetLinks(process.env.TWA_CERT_SHA256), {
    headers: { 'Cache-Control': 'public, max-age=3600' },
  });
}
