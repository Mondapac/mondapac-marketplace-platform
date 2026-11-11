import { getTranslations } from 'next-intl/server';

/**
 * What a page shows while its server read is still running: a banner and a grid of card shapes.
 * It is the `loading.tsx` of every route that never answers 404 or redirects after its read (home,
 * cart, checkout, account). A `loading.tsx` sends the page shell with HTTP 200 before the page has
 * read anything, so the product and store routes, whose 404 and 308 must be decided first, have
 * none (see `app/p/[id]/page.tsx`).
 */
export async function RouteLoading() {
  const t = await getTranslations('route');
  return (
    <div role="status" aria-label={t('loading')} className="loading">
      <div className="skel banner" />
      <div className="grid">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="skel card" />
        ))}
      </div>
    </div>
  );
}
