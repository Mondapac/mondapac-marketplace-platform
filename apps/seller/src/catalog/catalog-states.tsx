import { BackLink, EmptyState, LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { SellerShell } from '../server/seller-shell.tsx';
import type { CatalogPage } from '../server/catalog-page.ts';

const LISTS: Record<string, { readonly href: string; readonly key: string }> = {
  s_offers: { href: '/offers', key: 'catalog.offers.back' },
  s_products: { href: '/products', key: 'catalog.products.back' },
};

/** The pages' non-ok states: no access, not found, unavailable. Returns null when `page` is ok. */
export async function catalogStateFor(
  page: CatalogPage<unknown>,
  activeId: string,
  title: string,
): Promise<React.ReactElement | null> {
  const t = await getTranslations();
  if (page.kind === 'ok') return null;
  if (page.kind === 'unavailable') {
    return <LoadError message={t('catalog.error.unavailable')} retryLabel={t('load.retry')} />;
  }
  const key = page.kind === 'no-access' ? 'no-access' : 'not-found';
  // Not found goes back to the list it came from; no access to the list goes home.
  const list = key === 'not-found' ? LISTS[activeId] : undefined;
  return (
    <SellerShell session={page.session} activeId={activeId} title={title}>
      <EmptyState
        size="page"
        icon={key === 'no-access' ? 'lock' : 'package'}
        title={t(`catalog.${key}.title`)}
        body={t(`catalog.${key}.body`)}
        action={
          list === undefined ? (
            <BackLink href="/" label={t('catalog.back-home')} />
          ) : (
            <BackLink href={list.href} label={t(list.key)} />
          )
        }
      />
    </SellerShell>
  );
}
