import { NextResponse, type NextRequest } from 'next/server';
import { securityHeaders } from './src/server/security-headers.ts';

// Runs before every page (Next 16 "proxy"): sets the nonce and the security headers. Access
// control is not decided here; the relay and the page do that (ADR-0034 decision 6).
//
// The BFF relay (`/api/...`) is left out of the matcher on purpose. For every request a proxy
// matches, Next clones the body into memory up to 10 MB and cuts the rest, which broke an upload
// of more than about 7.5 MB (the import file in base64 is 14.5 MB) and buffered unauthenticated
// bodies. Nothing the proxy does is needed there: the nonce and the CSP serve rendered pages,
// and the relay sets its own `nosniff` and `cache-control` on every answer (`bff.ts`). Its body
// is capped by the relay itself, after the session is known (Hassan I-585-5, M-599-1).
export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const headers = securityHeaders(nonce, process.env.NODE_ENV !== 'production');
  const forwarded = new Headers(request.headers);
  forwarded.set('x-nonce', nonce);
  forwarded.set('content-security-policy', headers['content-security-policy'] ?? '');
  const response = NextResponse.next({ request: { headers: forwarded } });
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image|favicon.ico|api/).*)' }],
};
