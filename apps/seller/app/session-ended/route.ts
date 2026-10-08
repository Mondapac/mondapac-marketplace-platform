import { panelConfig } from '../../src/server/config.ts';
import { panelHostFor, upstreamHeaders } from '../../src/server/bff.ts';

/**
 * Where a page lands when the API rejected the session cookie. Server components cannot set
 * cookies, so this handler asks the API once more and relays whatever `Set-Cookie` it answers
 * with (the clearing of the rejected cookie), then sends the browser to the sign-in page with the
 * "session ended" notice (ADR-0034 decision 4).
 */
export async function GET(request: Request): Promise<Response> {
  const config = panelConfig();
  const host = panelHostFor(config, request.headers.get('host'));
  if (host === undefined) return new Response(null, { status: 404 });
  const headers = new Headers({ location: `${host.origin}/sign-in?notice=session-ended` });
  headers.set('cache-control', 'private, no-store');
  try {
    const upstream = await fetch(`${config.apiBaseUrl}/identity/seller/session`, {
      headers: upstreamHeaders(request, host),
      cache: 'no-store',
      redirect: 'manual',
    });
    for (const cookie of upstream.headers.getSetCookie()) headers.append('set-cookie', cookie);
  } catch {
    // The API is unreachable: the notice still tells the truth about the page the user left.
  }
  return new Response(null, { status: 303, headers });
}
