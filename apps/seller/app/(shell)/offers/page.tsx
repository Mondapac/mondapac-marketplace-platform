import { PageHeader } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { catalogStateFor } from '../../../src/catalog/catalog-states.tsx';
import { OffersList } from '../../../src/catalog/offers-list.tsx';
import { firstPagePath, type ListPaging } from '../../../src/catalog/offers-query.ts';
import type { OfferListPage } from '../../../src/catalog/types.ts';
import { panelHostFor } from '../../../src/server/bff.ts';
import { catalogGate, loadCatalogPage } from '../../../src/server/catalog-page.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { ProbationBar } from '../../../src/catalog/probation-bar.tsx';
import { loadReviewStanding } from '../../../src/server/review-standing.ts';
import { SellerShell } from '../../../src/server/seller-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.offers.title') };
}

/**
 * The Offers page: the first page is read here (every Offer, newest first), and the list follows
 * the Market's "List paging" setting. A setting that cannot be read means Previous and next, which
 * works for any number of Offers.
 */
export default async function OffersPage() {
  const t = await getTranslations();
  const title = t('catalog.offers.title');
  const gate = await catalogGate();
  if (gate.kind !== 'ok') return catalogStateFor(gate, 's_offers', title);
  const mode = await serverGet<{ readonly listPaging: string }>('settings/seller/list-paging');
  const paging: ListPaging =
    mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const page = await loadCatalogPage<OfferListPage>(firstPagePath(paging));
  const state = await catalogStateFor(page, 's_offers', title);
  if (state !== null || page.kind !== 'ok') return state;
  const standing = await loadReviewStanding();
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  const { session } = page;
  return (
    <SellerShell session={session} activeId="s_offers" title={title}>
      <PageHeader title={title} className="mb-4" />
      <div className="mb-4 empty:hidden">
        <ProbationBar standing={standing} />
      </div>
      <OffersList
        initial={page.body}
        paging={paging}
        accountId={session.accountId}
        marketId={marketId}
        csrfToken={session.csrfToken}
        permissionKeys={session.permissionKeys}
        timeZone={session.timezone}
      />
    </SellerShell>
  );
}
