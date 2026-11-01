/** The nonce in a Content-Security-Policy header, or null; the proxy puts the policy on the request. */
export function nonceOf(policy: string | null): string | null {
  return /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(policy ?? '')?.[1] ?? null;
}
