import { childPaths, sitemapHost, urlSetXml, SitemapReadFailed } from '../../../src/seo/sitemap.ts';
import {
  notFoundResponse,
  unavailableResponse,
  xmlResponse,
} from '../../../src/seo/sitemap-response.ts';

export const dynamic = 'force-dynamic';

interface Props {
  readonly params: Promise<{ name: string }>;
}

export async function GET(_request: Request, { params }: Props): Promise<Response> {
  const host = await sitemapHost();
  if (host === undefined) return notFoundResponse();
  try {
    const paths = await childPaths((await params).name);
    return paths === null ? notFoundResponse() : xmlResponse(urlSetXml(host.origin, paths));
  } catch (error) {
    if (error instanceof SitemapReadFailed) return unavailableResponse();
    throw error;
  }
}
