'use client';

import { useTranslations } from 'next-intl';
import { Icon } from '../icons/icon.tsx';
import { useSearchCollapse } from '../shell/search-collapse.ts';
import { useStore } from '../shell/store-context.tsx';

/**
 * The phone home page's search field (under 700px; CSS hides it above, where the header has its
 * own box). It looks like a field but is a button that opens the full-screen search view, so the
 * search logic stays in one place. Sticky under the header; it slides behind the header when
 * collapsed (a transform, so nothing moves) and the header shows a search icon instead.
 */
export function HomeSearch() {
  const t = useTranslations('header');
  const { setSearchOpen, setBrowseOpen, setCartOpen } = useStore();
  useSearchCollapse();
  return (
    <div className="hs">
      <button
        className="hs-field"
        type="button"
        aria-haspopup="dialog"
        onClick={() => {
          setBrowseOpen(false);
          setCartOpen(false);
          setSearchOpen(true);
        }}
      >
        <Icon name="search" />
        <span>{t('search-placeholder')}</span>
      </button>
    </div>
  );
}
