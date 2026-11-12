import { getTranslations } from 'next-intl/server';
import { catalogStateFor } from '../../../src/catalog/catalog-states.tsx';
import { ProposalsView } from '../../../src/categories/proposals-view.tsx';
import type { CatalogPage } from '../../../src/server/catalog-page.ts';
import {
  loadProposalsPage,
  type ProposalsPageData,
} from '../../../src/server/category-proposals-page.ts';
import { SellerShell } from '../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('categories.proposals.title') };
}

export default async function CategoryProposalsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const t = await getTranslations();
  const title = t('categories.proposals.title');
  const page: CatalogPage<ProposalsPageData> = await loadProposalsPage();
  const state = await catalogStateFor(page, 's_categories', title);
  if (state !== null || page.kind !== 'ok') return state;
  return (
    <SellerShell session={page.session} activeId="s_categories" title={title}>
      <h1 className="mb-2 text-2xl font-semibold">{title}</h1>
      <div className="max-w-(--mp-size-form-max)">
        <ProposalsView
          data={page.body.proposals}
          parents={page.body.parents}
          locales={page.body.locales}
          csrfToken={page.session.csrfToken}
          sent={query.sent === '1'}
        />
      </div>
    </SellerShell>
  );
}
