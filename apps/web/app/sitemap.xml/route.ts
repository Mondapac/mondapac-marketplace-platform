import { indexXml, childNames, sitemapHost, SitemapReadFailed } from '../../src/seo/sitemap.ts';
import {
  xmlResponse,
  notFoundResponse,
  unavailableResponse,
} from '../../src/seo/sitemap-response.ts';

// Read per request: the indexing switch and the host decide whether it exists at all.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const host = await sitemapHost();
  if (host === undefined) return notFoundResponse();
  try {
    return xmlResponse(indexXml(host.origin, await childNames()));
  } catch (error) {
    if (error instanceof SitemapReadFailed) return unavailableResponse();
    throw error;
  }
}
