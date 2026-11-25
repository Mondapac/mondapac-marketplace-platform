import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { catalogStateFor } from '../../../../src/catalog/catalog-states.tsx';
import { moreOf, QUICK_MAX, quickIdsOf } from '../../../../src/catalog/quick-entry-logic.ts';
import { QuickEntryTable } from '../../../../src/catalog/quick-entry.tsx';
import { canEstimateReceive } from '../../../../src/price/receive-permissions.ts';
import { PRICE_EDIT_PERMISSION } from '../../../../src/price/types.ts';
import { panelHostFor } from '../../../../src/server/bff.ts';
import { catalogGate } from '../../../../src/server/catalog-page.ts';
import { panelConfig } from '../../../../src/server/config.ts';
import { loadQuickEntry } from '../../../../src/server/quick-entry.ts';
import { SellerShell } from '../../../../src/server/seller-shell.tsx';
import { STOCK_EDIT_PERMISSION } from '../../../../src/stock/levels-types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.quick-entry.title') };
}

/**
 * The quick entry table of new drafts (Offer page PR 5): after "Sell these (N)" every size of the
 * new drafts is in one table, price and stock typed row after row and saved with one explicit
 * Save. The address names the drafts (`ids`, at most `QUICK_MAX`) and how many more wait in
 * Drafts (`more`). Without a draft to show it goes to the Drafts tab.
 */
export default async function QuickEntryPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const ids = quickIdsOf(query.ids, QUICK_MAX);
  if (ids.length === 0) redirect('/offers?view=drafts');
  const t = await getTranslations();
  const title = t('catalog.quick-entry.title');
  const gate = await catalogGate();
  if (gate.kind !== 'ok') return catalogStateFor(gate, 's_offers', title);
  const { session } = gate;
  const keys = session.permissionKeys;
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  const entry = await loadQuickEntry(ids, keys, marketId, (number) =>
    t('catalog.variants-table.variant-n', { number }),
  );
  return (
    <SellerShell session={session} activeId="s_offers" title={title}>
      <QuickEntryTable
        groups={entry.groups}
        unreadable={entry.unreadable}
        more={moreOf(query.more)}
        sources={entry.sources}
        stockUnavailable={entry.stockUnavailable}
        currency={entry.currency}
        canEditPrice={keys.includes(PRICE_EDIT_PERMISSION)}
        canEditStock={keys.includes(STOCK_EDIT_PERMISSION)}
        canEstimate={canEstimateReceive(keys)}
        csrfToken={session.csrfToken}
      />
    </SellerShell>
  );
}
