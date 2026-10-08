// The address just entered, kept for the "check your email" page only. sessionStorage ends
// with the tab; the address is never put in a URL (identity ux A3). Storage can be blocked, so
// every access is guarded and the page works without it.
const KEY = 'mp.pending-email';

export function rememberEmail(email: string): void {
  try {
    sessionStorage.setItem(KEY, email);
  } catch {
    // Blocked storage: the check-email page asks for the address instead.
  }
}

export function recallEmail(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}
