import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { BrowseCrumb } from '../catalog/browse-crumb.tsx';
import { Icon } from '../icons/icon.tsx';
import type { BrandIndex } from '../storefront/types.ts';
import { BrandLogo } from './brand-pictures.tsx';

// The brands page (design B5, `/brands`): every active brand A to Z, a row of letters at the top to
// jump to a section, then one grid of logo tiles per letter. Each tile opens the brand page. The
// letter `#` holds the brands that start with anything but A to Z.

/** The id of a letter's section, which the jump row links to. */
export const letterId = (letter: string): string =>
  letter === '#' ? 'brands-other' : `brands-${letter.toLowerCase()}`;

export function BrandsPage({ index }: { readonly index: BrandIndex }) {
  const t = useTranslations('brands');
  const { sections } = index;
  if (sections.length === 0)
    return (
      <div className="br">
        <h1 className="sr-only">{t('title')}</h1>
        <div className="shop-empty">
          <Icon name="tag" />
          <h2>{t('none-title')}</h2>
          <p>{t('none-body')}</p>
          <BrowseCrumb className="btn" label={t('browse-products')} />
        </div>
      </div>
    );
  return (
    <div className="br">
      <header className="br-index-head">
        <h1>{t('title')}</h1>
        <p>{t('intro')}</p>
      </header>
      <nav className="br-jump" aria-label={t('jump')}>
        <ul>
          {sections.map(({ letter }) => (
            <li key={letter}>
              <a href={`#${letterId(letter)}`}>
                <span aria-hidden="true">{letter}</span>
                <span className="sr-only">{letter === '#' ? t('other') : letter}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {sections.map(({ letter, brands }) => (
        <section
          key={letter}
          id={letterId(letter)}
          className="br-letter"
          aria-labelledby={`${letterId(letter)}-h`}
        >
          <h2 id={`${letterId(letter)}-h`}>{letter === '#' ? t('other') : letter}</h2>
          <ul className="br-grid">
            {brands.map((brand) => (
              <li key={brand.slug}>
                <Link className="br-tile" href={`/brands/${encodeURIComponent(brand.slug)}`}>
                  <BrandLogo name={brand.name} logo={brand.logo} size="sm" />
                  <span className="br-name">{brand.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {index.truncated ? <p className="br-note">{t('truncated')}</p> : null}
    </div>
  );
}

/** The route's loading state: the heading row and a grid of grey brand tiles. */
export function BrandsLoading({
  title,
  label,
}: {
  readonly title: string;
  readonly label: string;
}) {
  return (
    <div className="br" role="status" aria-label={label} aria-busy="true">
      <h1 className="sr-only">{title}</h1>
      <div className="skel title" aria-hidden="true" />
      <div className="br-grid" aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="skel br-skel-tile" />
        ))}
      </div>
    </div>
  );
}
