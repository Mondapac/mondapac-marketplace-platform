import { useTranslations } from 'next-intl';
import { Icon } from '../icons/icon.tsx';

/**
 * The search box of the results page on phones and tablets, filled with the words searched for;
 * the header's box takes its place on the desktop layout.
 */
export function SearchRefine({
  value,
  category,
}: {
  readonly value: string;
  readonly category?: string;
}) {
  const t = useTranslations('header');
  return (
    <form className="refine" role="search" action="/search">
      <label className="sin">
        <Icon name="search" />
        <input
          type="search"
          name="q"
          defaultValue={value}
          placeholder={t('search-placeholder')}
          aria-label={t('search')}
          minLength={2}
          maxLength={100}
        />
      </label>
      {category ? <input type="hidden" name="category" value={category} /> : null}
    </form>
  );
}
