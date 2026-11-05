import { Banner, LinkButton, Tabs } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { catalogStateFor } from '../../../src/catalog/catalog-states.tsx';
import { SuggestionsTable } from '../../../src/catalog/suggestions-table.tsx';
import {
  EDIT_PERMISSION,
  SUGGESTION_STATUSES,
  type OwnSuggestionList,
} from '../../../src/catalog/types.ts';
import { afterIdParam, loadCatalogPage } from '../../../src/server/catalog-page.ts';
import { SellerShell } from '../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.suggestions.title') };
}

const FILTERS = ['all', ...SUGGESTION_STATUSES] as const;

/** A status filter from the query string; anything else shows every status. */
function statusParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && (SUGGESTION_STATUSES as readonly string[]).includes(value)
    ? value
    : undefined;
}

export default async function ValueSuggestionsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const after = afterIdParam(query.after);
  const status = statusParam(query.status);
  const t = await getTranslations();
  const title = t('catalog.suggestions.title');
  const params = new URLSearchParams();
  if (status !== undefined) params.set('status', status);
  if (after !== undefined) params.set('afterId', after);
  const search = params.toString();
  const page = await loadCatalogPage<OwnSuggestionList>(
    `catalog/seller/attribute-suggestions${search === '' ? '' : `?${search}`}`,
  );
  const state = await catalogStateFor(page, 's_suggestions', title);
  if (state !== null || page.kind !== 'ok') return state;
  const { body } = page;
  const canSuggest = page.session.permissionKeys.includes(EDIT_PERMISSION);
  const full = body.openCount >= body.maxOpen;
  // Nothing sent yet: the empty state says it all, without a 0 counter and tabs over nothing.
  const none = status === undefined && after === undefined && body.items.length === 0;
  const newButton = canSuggest ? (
    <LinkButton href="/value-suggestions/new">{t('catalog.suggestions.new.start')}</LinkButton>
  ) : null;
  const filterHref = (filter: string) =>
    filter === 'all' ? '/value-suggestions' : `/value-suggestions?status=${filter}`;
  const next =
    body.nextAfterId === null
      ? null
      : `/value-suggestions?${new URLSearchParams({
          ...(status === undefined ? {} : { status }),
          after: body.nextAfterId,
        }).toString()}`;
  return (
    <SellerShell session={page.session} activeId="s_suggestions" title={title}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {/* An empty list carries the action in its empty state, so it is shown once. */}
        {body.items.length > 0 && !full ? newButton : null}
      </div>
      <p className="mb-4 max-w-(--mp-size-form-max) text-sm text-fg-muted">
        {t('catalog.suggestions.intro')}
      </p>
      <div className="mb-4 flex flex-col gap-3">
        {query.sent === '1' ? (
          <Banner tone="success">{t('catalog.suggestions.sent')}</Banner>
        ) : null}
        {none ? null : (
          <p className="text-sm font-medium" data-testid="open-count">
            {t('catalog.suggestions.waiting', { count: body.openCount, max: body.maxOpen })}
          </p>
        )}
        {full ? <Banner tone="info">{t('catalog.suggestions.full')}</Banner> : null}
      </div>
      <div className={none ? 'hidden' : 'mb-4'}>
        <Tabs
          label={t('catalog.suggestions.filter')}
          activeId={status ?? 'all'}
          items={FILTERS.map((filter) => ({
            id: filter,
            label: t(`catalog.suggestions.filters.${filter}`),
            href: filterHref(filter),
          }))}
        />
      </div>
      <SuggestionsTable
        items={body.items}
        defaultLocale={body.locales.default}
        filtered={status !== undefined}
        emptyAction={status === undefined ? newButton : null}
      />
      {next === null ? null : (
        <p className="mt-4">
          <a className="font-medium text-link underline" href={next}>
            {t('catalog.next-page')}
          </a>
        </p>
      )}
    </SellerShell>
  );
}
