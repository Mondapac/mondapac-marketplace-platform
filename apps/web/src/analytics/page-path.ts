// The path a page view reports. The query string is dropped where it can carry personal data
// (search words, account and checkout state), so none of it reaches Google.

const NO_QUERY = ['/search', '/cart', '/account', '/checkout'] as const;

export function reportedPath(pathname: string, search: string): string {
  const bare = NO_QUERY.some((base) => pathname === base || pathname.startsWith(`${base}/`));
  const query = search.startsWith('?') ? search : search === '' ? '' : `?${search}`;
  return bare || query === '?' ? pathname : `${pathname}${query}`;
}
