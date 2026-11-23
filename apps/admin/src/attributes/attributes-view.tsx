'use client';

import { Banner, Tabs } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { ListPagingMode } from '../shared/paged-list/types.ts';
import { AttributesList } from './attributes-list.tsx';
import { ValueSuggestionsList } from './value-suggestions-list.tsx';
import { FeatureSetsTab } from './feature-sets-tab.tsx';
import { MissingDetailsList } from './missing-details-list.tsx';
import { WaitingTab } from './waiting-tab.tsx';
import { ATTRIBUTES_PATH, BRANDS_PATH, attributePath, type Tab } from './types.ts';

/**
 * The Attributes page (attributes plan 16, package A1): four tabs. Attributes is a full-width super
 * list (an attribute opens on its own page); Feature sets is a list with the chosen set's details
 * beside it (below it on a narrow screen); Brands is the
 * brands page; Missing details is the report of products missing a required detail (A4); Waiting for you holds the requests to turn off Material (A2 part 3) and the sellers' value
 * suggestions (A5). An admin with `catalog.attribute.edit`
 * adds and edits attributes (package A2); any other admin sees the view-only notice.
 */
export function AttributesView({
  canEdit,
  canRestructure = false,
  csrfToken,
  canSeeBrands,
  canDecide,
  initialTab,
  initialId,
  paging,
  accountId,
  marketId,
  zone,
}: {
  readonly canEdit: boolean;
  /** `catalog.attribute.restructure`: merge values, archive and confirm an archive request. */
  readonly canRestructure?: boolean;
  readonly csrfToken: string;
  readonly canSeeBrands: boolean;
  readonly canDecide: boolean;
  readonly initialTab: Tab;
  /** The feature set the address names (`?id=` on the Feature sets tab). */
  readonly initialId: string | null;
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  /** The IANA zone of the table's times and of the Requested presets. */
  readonly zone: string;
}) {
  const t = useTranslations('attributes');
  const [tab, setTab] = useState<Tab>(initialTab);
  const [selected, setSelected] = useState<string | null>(initialId);

  // The address names the tab and the open row, so a link or a reload opens the same view.
  useEffect(() => {
    const query = new URLSearchParams();
    if (tab !== 'attributes') query.set('tab', tab);
    if (tab === 'feature-sets' && selected !== null) query.set('id', selected);
    const next = query.size === 0 ? ATTRIBUTES_PATH : `${ATTRIBUTES_PATH}?${query.toString()}`;
    // The list keeps its own query (views, filters, sort, page) in the address.
    if (tab === 'attributes') return;
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.replaceState(null, '', next);
    }
  }, [tab, selected]);

  const items = [
    { id: 'attributes', label: t('tab.attributes'), help: 'Attributes' },
    { id: 'feature-sets', label: t('tab.feature-sets'), help: 'Feature sets' },
    ...(canSeeBrands ? [{ id: 'brands', label: t('tab.brands'), href: BRANDS_PATH }] : []),
    { id: 'waiting', label: t('tab.waiting'), help: 'Waiting for you' },
    { id: 'missing-details', label: t('tab.missing-details'), help: 'Missing details' },
  ];

  return (
    <div className="mt-1 flex flex-col gap-4">
      <Tabs
        label={t('tabs')}
        items={items}
        activeId={tab}
        onSelect={(id) => {
          setTab(id as Tab);
          setSelected(null);
        }}
      />
      {canEdit ? null : (
        <Banner tone="info" title={t('view-only.title')}>
          {t('view-only.body')}
        </Banner>
      )}
      {tab === 'attributes' ? (
        <AttributesList
          paging={paging}
          accountId={accountId}
          marketId={marketId}
          canEdit={canEdit}
          canRestructure={canRestructure}
          csrfToken={csrfToken}
        />
      ) : null}
      {tab === 'feature-sets' ? (
        <FeatureSetsTab
          canEdit={canEdit}
          csrfToken={csrfToken}
          selectedId={selected}
          onSelect={setSelected}
          onOpenAttribute={(id) => window.location.assign(attributePath(id))}
        />
      ) : null}
      {tab === 'waiting' ? (
        <WaitingTab
          canEdit={canEdit}
          canRestructure={canRestructure}
          csrfToken={csrfToken}
          onOpenAttribute={(id) => window.location.assign(attributePath(id))}
        />
      ) : null}
      {tab === 'missing-details' ? (
        <MissingDetailsList
          paging={paging}
          accountId={accountId}
          marketId={marketId}
          canEdit={canEdit}
          csrfToken={csrfToken}
        />
      ) : null}
      {tab === 'waiting' && canDecide ? (
        <section aria-labelledby="suggestions-heading" className="flex flex-col gap-4">
          <h2 id="suggestions-heading" className="text-lg font-semibold text-fg">
            {t('suggestions.title')}
          </h2>
          <ValueSuggestionsList
            paging={paging}
            accountId={accountId}
            marketId={marketId}
            zone={zone}
            csrfToken={csrfToken}
          />
        </section>
      ) : null}
    </div>
  );
}
