import { Banner, Button, LinkButton, Tabs } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { catalogStateFor } from '../../../src/catalog/catalog-states.tsx';
import { TagSuggestionsTable } from '../../../src/catalog/tag-suggestions-table.tsx';
import {
  EDIT_PERMISSION,
  SUGGESTION_STATUSES,
  type OwnTopicSuggestionList,
} from '../../../src/catalog/types.ts';
import { afterIdParam, loadCatalogPage } from '../../../src/server/catalog-page.ts';
import { SellerShell } from '../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.tagSuggestions.title') };
}

const ACTIVE = 's_tag_suggestions';
const FILTERS = ['all', ...SUGGESTION_STATUSES] as const;
const PAGE_SIZE = 25;

/** A status filter from the query string; anything else shows every status. */
function statusParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && (SUGGESTION_STATUSES as readonly string[]).includes(value)
    ? value
    : undefined;
}

export default async function TagSuggestionsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const after = afterIdParam(query.after);
  const status = statusParam(query.status);
  const t = await getTranslations();
  const title = t('catalog.tagSuggestions.title');
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (status !== undefined) params.set('status', status);
  if (after !== undefined) params.set('afterId', after);
  const page = await loadCatalogPage<OwnTopicSuggestionList>(
    `catalog/seller/topic-suggestions?${params.toString()}`,
  );
  const state = await catalogStateFor(page, ACTIVE, title);
  if (state !== null || page.kind !== 'ok') return state;
  const { body } = page;
  const canSuggest = page.session.permissionKeys.includes(EDIT_PERMISSION);
  const full = body.openCount >= body.maxOpen;
  // Nothing sent yet: the empty state says it all, without a counter and tabs over nothing.
  const none = status === undefined && after === undefined && body.items.length === 0;
  const startLabel = t('catalog.tagSuggestions.new.start');
  const newButton = !canSuggest ? null : full ? (
    <Button type="button" disabled aria-describedby="tag-limit">
      {startLabel}
    </Button>
  ) : (
    <LinkButton href="/tag-suggestions/new">{startLabel}</LinkButton>
  );
  const filterHref = (filter: string) =>
    filter === 'all' ? '/tag-suggestions' : `/tag-suggestions?status=${filter}`;
  const next =
    body.nextAfterId === null
      ? null
      : `/tag-suggestions?${new URLSearchParams({
          ...(status === undefined ? {} : { status }),
          after: body.nextAfterId,
        }).toString()}`;
  return (
    <SellerShell session={page.session} activeId={ACTIVE} title={title}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {/* An empty list carries the action in its empty state, so it is shown once. */}
        {body.items.length > 0 || status !== undefined || after !== undefined ? newButton : null}
      </div>
      <p className="mb-4 max-w-(--mp-size-form-max) text-sm text-fg-muted">
        {t('catalog.tagSuggestions.intro')}
      </p>
      <div className="mb-4 flex flex-col gap-3">
        {query.sent === '1' ? (
          <Banner tone="success">{t('catalog.tagSuggestions.sent')}</Banner>
        ) : null}
        {none ? null : (
          <p className="text-sm text-fg-muted" data-testid="open-count">
            {t('catalog.tagSuggestions.used', { count: body.openCount, max: body.maxOpen })}
          </p>
        )}
        {full ? (
          <div id="tag-limit">
            <Banner tone="attention">
              {t('catalog.tagSuggestions.full', { max: body.maxOpen })}
            </Banner>
          </div>
        ) : null}
      </div>
      <div className={none ? 'hidden' : 'mb-4'}>
        <Tabs
          label={t('catalog.tagSuggestions.filter')}
          activeId={status ?? 'all'}
          items={FILTERS.map((filter) => ({
            id: filter,
            label: t(`catalog.tagSuggestions.filters.${filter}`),
            href: filterHref(filter),
          }))}
        />
      </div>
      <TagSuggestionsTable
        items={body.items}
        defaultLocale={body.locales.default}
        filtered={status !== undefined}
        emptyAction={status === undefined ? newButton : null}
      />
      {next === null ? null : (
        <p className="mt-4">
          <LinkButton href={next} variant="secondary">
            {t('catalog.tagSuggestions.more')}
          </LinkButton>
        </p>
      )}
    </SellerShell>
  );
}
