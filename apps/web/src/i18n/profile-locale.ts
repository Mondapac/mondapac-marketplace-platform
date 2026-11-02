import 'server-only';
import { sessionGet } from '../storefront/session.ts';
import { publishedLocales } from './locale.ts';

/**
 * The signed-in buyer's language kept on the profile, or null (a guest, an ended session, no
 * choice, or the API off). Nothing is asked while the Market publishes only English: every request
 * reads in English then, so the session read would change nothing.
 */
export async function readProfileLocale(
  published: readonly string[] = publishedLocales(),
): Promise<string | null> {
  if (published.length <= 1) return null;
  const read = await sessionGet<{ readonly locale?: unknown }>('identity/customer/session');
  if (read.kind !== 'ok') return null;
  const locale = read.body.locale;
  return typeof locale === 'string' ? locale : null;
}
