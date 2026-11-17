// The internal preview token of the buyer assistant (stage 0, B4 and F1). An admin takes a
// 30-minute token from the panel and opens any storefront URL with `#assistant-preview=<token>`.
// The token is a bearer secret for those 30 minutes, so it travels one way only:
//   URL fragment -> this tab's sessionStorage -> the `x-assistant-preview` request header.
// It is removed from the address bar at once (a fragment is never sent to a server, but it would
// stay in the history entry, a copied link and the page's own scripts). It is never put in a query
// string, a cookie, localStorage, a log, an analytics event or an error message.

/** The sessionStorage key: this tab only, gone when it closes. */
export const PREVIEW_KEY = 'sf-assistant-preview';

/** The fragment parameter the panel appends. */
export const PREVIEW_PARAM = 'assistant-preview';

/** base64url plus the dots of `ap1.<expiry>.<nonce>.<mac>`; bounded so nothing odd is stored. */
const TOKEN_SHAPE = /^[A-Za-z0-9._-]{20,300}$/;

type Reading = Pick<Storage, 'getItem'>;
type Writing = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** True for a string of the shape of a preview token (the server decides whether it is valid). */
export const isPreviewToken = (value: unknown): value is string =>
  typeof value === 'string' && TOKEN_SHAPE.test(value);

/** The token kept for this tab, or null when there is none or storage is unavailable. */
export function storedPreview(storage: Reading | null): string | null {
  try {
    const kept = storage?.getItem(PREVIEW_KEY) ?? null;
    return isPreviewToken(kept) ? kept : null;
  } catch {
    return null;
  }
}

/** Forgets the token (the server did not accept it, or it expired). */
export function dropPreview(storage: Pick<Storage, 'removeItem'> | null): void {
  try {
    storage?.removeItem(PREVIEW_KEY);
  } catch {
    // Storage blocked: nothing was kept.
  }
}

/** The part of `window.location` that is read. */
export interface PreviewLocation {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

/** The part of `window.history` that is used. */
export interface PreviewHistory {
  readonly state: unknown;
  replaceState(state: unknown, unused: string, url: string): void;
}

/**
 * Takes a preview token out of the URL fragment, once, on load. A well-shaped token is stored in
 * the session storage; either way the parameter is removed from the address with `replaceState`
 * (path and query kept, any other fragment part kept, no new history entry). Returns the token
 * now in force for this tab: the one just taken, else one stored earlier, else null.
 */
export function takePreview(
  location: PreviewLocation,
  history: PreviewHistory,
  storage: Writing | null,
): string | null {
  const fragment = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (fragment.includes(`${PREVIEW_PARAM}=`)) {
    const rest: string[] = [];
    let taken: string | null = null;
    for (const part of fragment.split('&')) {
      if (part.startsWith(`${PREVIEW_PARAM}=`)) {
        const value = part.slice(PREVIEW_PARAM.length + 1);
        if (isPreviewToken(value)) taken = value;
      } else if (part !== '') rest.push(part);
    }
    try {
      history.replaceState(
        history.state,
        '',
        `${location.pathname}${location.search}${rest.length > 0 ? `#${rest.join('&')}` : ''}`,
      );
    } catch {
      // A browser that refuses replaceState leaves the address as it was.
    }
    if (taken !== null) {
      try {
        storage?.setItem(PREVIEW_KEY, taken);
      } catch {
        // Storage blocked: the token still serves this page view through the return value.
        return taken;
      }
      return taken;
    }
  }
  return storedPreview(storage);
}
