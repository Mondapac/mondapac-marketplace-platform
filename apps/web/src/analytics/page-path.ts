// The path a page view reports. The query string is dropped where it can carry personal data
// (search words, account and checkout state), so none of it reaches Google.

const NO_QUERY = ['/search', '/cart', '/account', '/checkout'] as const;

/** Routes whose URL query and page title may carry personal data (search words, names, orders). */
export const isPrivateRoute = (pathname: string): boolean =>
  NO_QUERY.some((base) => pathname === base || pathname.startsWith(`${base}/`)) ||
  isInvitePath(pathname);

/** A store's invite link (`/invite/<token>`): the token is a credential and is never reported. */
const isInvitePath = (pathname: string): boolean =>
  pathname === '/invite' || pathname.startsWith('/invite/');

/** The title a page view reports: the real title, but only the path on a private route (the search page's title holds the words searched for). */
export const reportedTitle = (pathname: string, title: string): string =>
  isPrivateRoute(pathname) ? reportedPath(pathname, '') : title;

/**
 * The referrer a page view reports. From this site: its path, cleaned like any page view. From
 * another site: only its origin. Never a query string.
 */
export function reportedReferrer(referrer: string, origin: string): string {
  try {
    const url = new URL(referrer);
    return url.origin === origin
      ? `${origin}${reportedPath(url.pathname, url.search)}`
      : url.origin;
  } catch {
    return '';
  }
}

export function reportedPath(pathname: string, search: string): string {
  // The token is part of the path itself, so the path is cut, not just its query.
  if (isInvitePath(pathname)) return '/invite';
  const bare = isPrivateRoute(pathname);
  const query = search.startsWith('?') ? search : search === '' ? '' : `?${search}`;
  return bare || query === '?' ? pathname : `${pathname}${query}`;
}
