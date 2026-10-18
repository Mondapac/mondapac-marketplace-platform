import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FilterChips } from '../../../../src/catalog/filter-chips.tsx';
import {
  Crumbs,
  EmptyResults,
  ProductResults,
  ResultsHead,
} from '../../../../src/catalog/results.tsx';
import { findProducts, pageOf } from '../../../../src/storefront/catalog.ts';
import { loadStorefrontContent } from '../../../../src/storefront/source.ts';

interface Props {
  readonly params: Promise<{ category: string; sub?: string[] }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** The category and subcategory of the path; an unknown one is a 404. */
async function resolve(params: Props['params']) {
  const { category: code, sub = [] } = await params;
  const content = await loadStorefrontContent();
  const category = content.categories.find((c) => c.code === code);
  if (!category || sub.length > 1) notFound();
  const child = sub.length === 0 ? undefined : category.children.find((c) => c.code === sub[0]);
  if (sub.length === 1 && !child) notFound();
  return { category, child };
}

export async function generateMetadata({ params }: Props) {
  const { category, child } = await resolve(params);
  const t = await getTranslations('store');
  return { title: `${child?.name ?? category.name} | ${t('title')}` };
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const [{ category, child }, query, t] = await Promise.all([
    resolve(params),
    searchParams,
    getTranslations('catalog'),
  ]);
  const base = `/c/${category.code}`;
  const path = child ? `${base}/${child.code}` : base;
  const result = await findProducts({
    category: category.code,
    ...(child ? { subcategory: child.code } : {}),
    page: pageOf(query.page),
  });
  const title = child?.name ?? category.name;
  const trail = [{ label: t('home'), href: '/' }];
  if (child) trail.push({ label: category.name, href: base });

  return (
    <>
      <ResultsHead title={title} crumbs={<Crumbs trail={trail} current={title} />}>
        <FilterChips
          label={t('filter-subcategory', { name: category.name })}
          chips={[
            { label: t('all'), href: base, current: !child },
            ...category.children.map((c) => ({
              label: c.name,
              href: `${base}/${c.code}`,
              current: c.code === child?.code,
            })),
          ]}
        />
      </ResultsHead>
      <ProductResults
        result={result}
        hrefFor={(page) => (page === 1 ? path : `${path}?page=${page}`)}
        empty={
          <EmptyResults message={t('category-empty', { name: title })}>
            <div className="actions">
              {child ? (
                <Link className="btn" href={base}>
                  {t('all-of', { name: category.name })}
                </Link>
              ) : null}
              <Link className={child ? 'btn alt' : 'btn'} href="/">
                {t('home-page')}
              </Link>
            </div>
          </EmptyResults>
        }
      />
    </>
  );
}
