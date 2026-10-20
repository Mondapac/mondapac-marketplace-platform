import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { SellerLogo } from '../product/seller-logo.tsx';
import { StoreCard } from '../sellers/store-card.tsx';
import type { ClosedStore } from '../storefront/types.ts';
import { Icon } from '../icons/icon.tsx';
import { FocusTitle } from './focus-title.tsx';

/**
 * A store that is not taking orders (approved design errors-a-teal v1): its static facts, ways
 * on, and other stores that deliver to the buyer as the sellers page cards. The reason (paused,
 * suspended, not live) is never shown.
 */
export function ClosedStoreView({
  store,
  ratingsShown,
}: {
  readonly store: ClosedStore;
  readonly ratingsShown: boolean;
}) {
  const t = useTranslations('errors');
  const ts = useTranslations('sellers');
  return (
    <div className="er">
      <div className="er-box">
        <div className="er-ic" aria-hidden="true">
          <Icon name="store" />
        </div>
        <FocusTitle>{t('store-title')}</FocusTitle>
        <p>{t('store-message')}</p>
        <div className="er-st">
          <SellerLogo logo={store.logo} />
          <div>
            <b>{store.name}</b>
            <span>
              {ts('selling-since', { city: store.city, year: String(store.sellingSince) })}
            </span>
          </div>
        </div>
        <div className="er-act">
          <Link className="btn" href="/sellers">
            {t('all-stores')}
          </Link>
          <Link className="btn ghost" href="/">
            {t('home')}
          </Link>
        </div>
      </div>
      {store.others.length > 0 ? (
        <section className="er-sec" aria-labelledby="er-others">
          <h2 id="er-others">{t('other-stores')}</h2>
          <div className="sl-grid">
            {store.others.map((s) => (
              <StoreCard
                key={s.id}
                store={s}
                location={store.location}
                ratingsShown={ratingsShown}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
