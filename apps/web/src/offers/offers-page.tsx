import { useTranslations } from 'next-intl';
import { BrowseCrumb } from '../catalog/browse-crumb.tsx';
import { Crumbs } from '../catalog/results.tsx';
import { ProductCard } from '../home/product-card.tsx';
import { Icon } from '../icons/icon.tsx';
import type { OffersPage as OffersData } from '../storefront/offers.ts';

// The Offers page (`/offers`): every product on special right now, newest special first, as the
// site's card grid. The route has no paging yet, so the page is one read of up to 24 cards.

export function OffersPage({ page }: { readonly page: OffersData }) {
  const t = useTranslations('offers');
  return (
    <div className="offers">
      <Crumbs trail={[{ label: t('home'), href: '/' }]} current={t('title')} />
      <h1>{t('title')}</h1>
      <Body page={page} />
    </div>
  );
}

function Body({ page }: { readonly page: OffersData }) {
  const t = useTranslations('offers');
  if (page.kind === 'failed')
    return (
      <div className="shop-empty" role="alert">
        <Icon name="info" />
        <h2>{t('failed')}</h2>
        <p>{t('failed-body')}</p>
        {/* A plain link: a full request, so the read really runs again. */}
        <a className="btn ghost" href="/offers">
          {t('try-again')}
        </a>
      </div>
    );
  if (page.items.length === 0)
    return (
      <div className="shop-empty">
        <Icon name="tag" />
        <h2>{t('none')}</h2>
        <p>{t('none-body')}</p>
        <BrowseCrumb className="btn" label={t('browse-products')} />
      </div>
    );
  return (
    <section aria-label={t('title')}>
      <p className="offers-count">{t('count', { count: page.items.length })}</p>
      <div className="shop-grid">
        {page.items.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>
    </section>
  );
}

/** The route's loading state: the heading and a grid of grey product cards. */
export function OffersLoading({
  title,
  label,
}: {
  readonly title: string;
  readonly label: string;
}) {
  return (
    <div className="offers" role="status" aria-label={label} aria-busy="true">
      <h1 className="sr-only">{title}</h1>
      <div className="skel title" aria-hidden="true" />
      <div className="shop-grid" aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="skel br-skel-card" />
        ))}
      </div>
    </div>
  );
}
