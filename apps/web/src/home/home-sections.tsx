import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { SAMPLE_SELLER_ART } from '../icons/seller-art.tsx';
import { Icon } from '../icons/icon.tsx';
import { CategoryArt } from '../icons/category-icon.tsx';
import type {
  Category,
  HomeSection,
  PromoBanner,
  SellerSummary,
  ShelfCard,
} from '../storefront/types.ts';
import { ProductCard } from './product-card.tsx';

/** The home page middle, in the order the content layout gives (admin-editable later). */
export function HomeSections({
  sections,
  categories,
  sellers,
}: {
  readonly sections: readonly HomeSection[];
  readonly categories: readonly Category[];
  readonly sellers: readonly SellerSummary[];
}) {
  const t = useTranslations('home');
  // The first promo banner holds the page's one h1; a layout without a banner gets a hidden one.
  const hasBanner = sections.some((s) => s.kind === 'promos' && s.banners.length > 0);
  const body = sections.map((section, index) => {
    switch (section.kind) {
      case 'promos':
        return <Promos key={index} banners={section.banners} />;
      case 'categories':
        return <CategoryStrip key={index} categories={categories} />;
      case 'sellers':
        return <Sellers key={index} title={section.title} href={section.href} sellers={sellers} />;
      case 'products':
        return (
          <Products
            key={index}
            title={section.title}
            href={section.href}
            products={section.products}
          />
        );
    }
  });
  return hasBanner ? (
    body
  ) : (
    <>
      <h1 className="sr-only">{t('title')}</h1>
      {body}
    </>
  );
}

function Promos({ banners }: { readonly banners: readonly PromoBanner[] }) {
  const t = useTranslations('home');
  if (banners.length === 0) return null;
  return (
    <section className="promos" aria-label={t('featured')}>
      {banners.map((banner, index) => {
        const Heading = index === 0 ? 'h1' : 'h2';
        return (
          <div key={banner.id} className={`promo ${banner.variant}`}>
            <div className={`pimgs ${banner.variant}`} aria-hidden="true">
              {banner.images.map((src, i) => (
                <img key={src} className={`i${i}`} src={src} alt="" />
              ))}
            </div>
            <Heading>{banner.title}</Heading>
            <p>{banner.body}</p>
            {banner.action ? (
              <Link
                className={banner.variant === 'primary' ? 'btn' : 'btn alt'}
                href={banner.action.href}
              >
                {banner.action.label}
              </Link>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function CategoryStrip({ categories }: { readonly categories: readonly Category[] }) {
  const t = useTranslations('home');
  if (categories.length === 0) return null;
  return (
    <section aria-label={t('categories')}>
      <div className="cats">
        {categories.map((c) => (
          <Link key={c.code} href={`/c/${c.code}`}>
            <span className="c">
              <CategoryArt code={c.code} />
            </span>
            {c.shortName}
          </Link>
        ))}
      </div>
    </section>
  );
}

function SectionHead({ title, href }: { readonly title: string; readonly href: string }) {
  const t = useTranslations('home');
  return (
    <div className="sech">
      <h2>{title}</h2>
      <Link href={href} aria-label={t('show-all-of', { title })}>
        {t('show-all')}
        <Icon name="chevr" />
      </Link>
    </div>
  );
}

function Sellers({
  title,
  href,
  sellers,
}: {
  readonly title: string;
  readonly href: string;
  readonly sellers: readonly SellerSummary[];
}) {
  const t = useTranslations('home');
  return (
    <section>
      <SectionHead title={title} href={href} />
      {sellers.length === 0 ? (
        <p className="empty">{t('no-sellers')}</p>
      ) : (
        <div className="sellers">
          {sellers.map((s) => {
            const art = s.logo ? SAMPLE_SELLER_ART[s.logo] : undefined;
            return (
              <Link key={s.id} className="seller" href={`/s/${s.id}`}>
                <span className={art ? 'lg art' : 'lg'} aria-hidden="true">
                  {art ? <svg viewBox="0 0 64 64">{art}</svg> : s.initials}
                </span>
                <b>{s.name}</b>
                <span className="eta">
                  <Icon name="clock" />
                  {s.deliveryWindow}
                </span>
                <span className="mn">{s.minimumOrder}</span>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Products({
  title,
  href,
  products,
}: {
  readonly title: string;
  readonly href: string;
  readonly products: readonly ShelfCard[];
}) {
  const t = useTranslations('home');
  return (
    <section>
      <SectionHead title={title} href={href} />
      {products.length === 0 ? (
        <p className="empty">{t('empty')}</p>
      ) : (
        <div className="grid">
          {products.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
      )}
    </section>
  );
}
