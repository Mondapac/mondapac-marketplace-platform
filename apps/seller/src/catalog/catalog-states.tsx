import { getTranslations } from 'next-intl/server';
import { SellerShell } from '../server/seller-shell.tsx';
import type { CatalogPage } from '../server/catalog-page.ts';

/** The pages' non-ok states: no access, not found, unavailable. Returns null when `page` is ok. */
export async function catalogStateFor(
  page: CatalogPage<unknown>,
  activeId: string,
  title: string,
): Promise<React.ReactElement | null> {
  const t = await getTranslations();
  if (page.kind === 'ok') return null;
  if (page.kind === 'unavailable') {
    return <p className="p-6 text-fg-muted">{t('catalog.error.unavailable')}</p>;
  }
  const key = page.kind === 'no-access' ? 'no-access' : 'not-found';
  return (
    <SellerShell session={page.session} activeId={activeId} title={title}>
      <h1 className="mb-2 text-2xl font-semibold">{t(`catalog.${key}.title`)}</h1>
      <p className="text-fg-muted">{t(`catalog.${key}.body`)}</p>
      <p className="mt-4">
        <a className="font-medium text-link underline" href="/">
          {t('catalog.back-home')}
        </a>
      </p>
    </SellerShell>
  );
}
