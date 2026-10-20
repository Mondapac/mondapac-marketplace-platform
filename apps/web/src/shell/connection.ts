/**
 * Whether the marketplace answers. `navigator.onLine` false is certain; true only means a network
 * is up, so a small no-store request to the offline page settles it.
 */
export async function reachable(): Promise<boolean> {
  if (!navigator.onLine) return false;
  try {
    const response = await fetch('/offline', { method: 'HEAD', cache: 'no-store' });
    return response.ok;
  } catch {
    return false;
  }
}

/** The shortest time "Checking..." shows, so a quick answer still reads as a check. */
export const CHECK_MIN_MS = 600;

/** `reachable()`, taking at least CHECK_MIN_MS. */
export async function checkReachable(): Promise<boolean> {
  const [ok] = await Promise.all([
    reachable(),
    new Promise((resolve) => setTimeout(resolve, CHECK_MIN_MS)),
  ]);
  return ok;
}
