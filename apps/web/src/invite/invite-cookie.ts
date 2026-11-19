// The invite link's token between the invite page and the sign-up journey (customers management
// phase 4a; Reza's spec 4). A first-party cookie, so it survives the sign-up and the email
// confirmation; it is read by script (the join call needs it) and never sent anywhere but the
// join call. The store's name rides along in a second cookie only to word the sign-up line.

export const INVITE_TOKEN_COOKIE = 'invite-token';
export const INVITE_STORE_COOKIE = 'invite-store';
/** One day: long enough for a sign-up and its email confirmation, short for a credential. */
const MAX_AGE_SECONDS = 24 * 60 * 60;

/** The shape an invite token must have to be kept (the API refuses any other as unknown). */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{8,200}$/;

const secure = (): string => (window.location.protocol === 'https:' ? '; Secure' : '');

export function keepInvite(token: string, storeName: string): void {
  if (!TOKEN_SHAPE.test(token)) return;
  const tail = `; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax${secure()}`;
  document.cookie = `${INVITE_TOKEN_COOKIE}=${token}${tail}`;
  document.cookie = `${INVITE_STORE_COOKIE}=${encodeURIComponent(storeName.slice(0, 100))}${tail}`;
}

export function clearInvite(): void {
  for (const name of [INVITE_TOKEN_COOKIE, INVITE_STORE_COOKIE])
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure()}`;
}

function cookie(name: string): string | null {
  const found = document.cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (found.length !== 1) return null;
  return found[0]!.slice(name.length + 1);
}

export interface KeptInvite {
  readonly token: string;
  /** null when the name cookie is missing: the words then say "the store". */
  readonly storeName: string | null;
}

export function readInvite(): KeptInvite | null {
  const token = cookie(INVITE_TOKEN_COOKIE);
  if (token === null || !TOKEN_SHAPE.test(token)) return null;
  const name = cookie(INVITE_STORE_COOKIE);
  const decoded = (): string | null => {
    try {
      return name === null || name === '' ? null : decodeURIComponent(name);
    } catch {
      return null;
    }
  };
  return { token, storeName: decoded() };
}
