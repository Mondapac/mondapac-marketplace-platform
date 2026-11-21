import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { OwnValueSuggestionsList } from '../../../src/catalog/own-suggestion-lists.tsx';
import { catalogGate } from '../../../src/server/catalog-page.ts';
import { catalogStateFor } from '../../../src/catalog/catalog-states.tsx';
import { panelHostFor } from '../../../src/server/bff.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { SellerShell } from '../../../src/server/seller-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { EDIT_PERMISSION } from '../../../src/catalog/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.suggestions.title') };
}

/**
 * The seller's value suggestions: the list loads in the browser (it follows the address, which
 * keeps the status tab, search, sort and page). The page reads the Market's "List paging"
 * setting once; when that fails the list pages with Previous and next.
 */
export default async function ValueSuggestionsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const t = await getTranslations();
  const title = t('catalog.suggestions.title');
  const gate = await catalogGate();
  if (gate.kind !== 'ok') return catalogStateFor(gate, 's_suggestions', title);
  const { session } = gate;
  const listPaging = await serverGet<{ readonly listPaging: string }>(
    'settings/seller/list-paging',
  );
  const paging =
    listPaging.kind === 'ok' && listPaging.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  return (
    <SellerShell session={session} activeId="s_suggestions" title={title}>
      <OwnValueSuggestionsList
        paging={paging}
        accountId={session.accountId}
        marketId={marketId}
        timeZone={session.timezone}
        canSuggest={session.permissionKeys.includes(EDIT_PERMISSION)}
        sent={query.sent === '1'}
      />
    </SellerShell>
  );
}
