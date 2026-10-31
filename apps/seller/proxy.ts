import { NextResponse, type NextRequest } from 'next/server';
import { securityHeaders } from './src/server/security-headers.ts';

// Runs before every page and route (Next 16 "proxy"): sets the nonce and the security headers.
// Access control is not decided here; the relay and the page do that (ADR-0034 decision 6).
// The BFF relay (`/api/...`) is left out of the matcher: Next clones and buffers every request body
// of a matched route in memory before the route runs (Hassan M-599-1), so a matched relay would
// buffer an upload before any session or size check. JSON answers need no nonce or CSP; the relay
// sets `x-content-type-options` itself.
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
