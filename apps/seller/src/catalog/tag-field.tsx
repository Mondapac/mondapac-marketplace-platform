'use client';

import { SearchSelect, type SearchSelectOption } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { pickLabel } from './draft-content.ts';
import type { TopicIssue } from './edit-errors.ts';
import type { TopicChoice, TopicPage, TopicRef } from './types.ts';

/** The most tags a product carries, until the picker answer says otherwise. */
export const DEFAULT_MAX_TAGS = 10;
/** The API's page maximum: the search narrows the list instead of paging it (no list end in the kit). */
const PAGE = 100;
const GROUPS: ReadonlySet<string> = new Set(['occasion', 'cuisine', 'use']);

/** What the form knows about a tag it has seen: its name and whether it is archived. */
export interface KnownTag {
  readonly name: string;
  readonly archived: boolean;
}
export type KnownTags = Map<string, KnownTag>;

export const nameOfChoice = (choice: TopicChoice, locale: string): string =>
  pickLabel(choice.names, locale, choice.name ?? choice.slug);

/**
 * The tags the page has seen, by id: those the product read names (always up to date) and those
 * the seller picked in this session. Both the field and the banner name a tag from here.
 */
export function useKnownTags(refs: readonly TopicRef[], defaultLocale: string): KnownTags {
  const known = useRef<KnownTags>(new Map());
  for (const ref of refs) {
    known.current.set(ref.id, {
      name: pickLabel(ref.names, defaultLocale, ref.name ?? ref.slug),
      archived: ref.status === 'archived',
    });
  }
  return known.current;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** One sentence per refused tag (and one for a list that is too long), in the order refused. */
export function topicSentences(
  t: Translate,
  issues: readonly TopicIssue[],
  ids: readonly string[],
  known: KnownTags,
  max: number,
): string[] {
  return issues.map((issue) => {
    if (issue.code === 'too-many') return t('catalog.edit.tags.too-many', { max });
    const entry = issue.index === null ? undefined : known.get(ids[issue.index] ?? '');
    if (entry === undefined) return t('catalog.edit.tags.unknown-problem');
    return t(`catalog.edit.tags.${issue.code}-problem`, { name: entry.name });
  });
}

/**
 * The seller's "Tags" field: a searchable multiple choice over the active tags of the Market
 * (`GET catalog/seller/topics`, server search). Saved tags are chips from the product read, so the
 * field needs no loading state of its own. An archived tag stays on the product as a chip that says
 * so in words; the list never offers one.
 */
export function TagField({
  ids,
  known,
  defaultLocale,
  productId,
  issues,
  max,
  onMax,
  onChange,
}: {
  readonly ids: readonly string[];
  readonly known: KnownTags;
  readonly defaultLocale: string;
  /** The product being edited: the "Suggest one" link names it. */
  readonly productId: string;
  /** The freeze refusals about tags, told as one sentence each next to the control. */
  readonly issues: readonly TopicIssue[];
  readonly max: number;
  readonly onMax: (max: number) => void;
  readonly onChange: (ids: string[]) => void;
}) {
  const t = useTranslations();
  const [results, setResults] = useState<readonly TopicChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const sequence = useRef(0);
  const lastQuery = useRef('');
  const [term, setTerm] = useState('');
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const search = useCallback(
    async (query: string) => {
      lastQuery.current = query;
      setTerm(query.trim());
      const mine = ++sequence.current;
      setLoading(true);
      setLoadError(undefined);
      const text = query.trim();
      const params = new URLSearchParams({ limit: String(PAGE) });
      if (text !== '') params.set('search', text);
      const result = await callApi<TopicPage>('GET', `catalog/seller/topics?${params.toString()}`);
      // A later search, or a closed page, has taken over.
      if (mine !== sequence.current || !mounted.current) return;
      setLoading(false);
      if (result.ok) {
        setResults(result.body.items);
        if (Number.isInteger(result.body.maxPerProduct) && result.body.maxPerProduct > 0) {
          onMax(result.body.maxPerProduct);
        }
        return;
      }
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setLoadError(
        t(
          result.failure.code === 'request.throttled'
            ? 'catalog.edit.tags.load-throttled'
            : 'catalog.edit.tags.load-error',
        ),
      );
    },
    [onMax, t],
  );

  const optionOf = (choice: TopicChoice): SearchSelectOption => ({
    value: choice.id,
    label: nameOfChoice(choice, defaultLocale),
    ...(GROUPS.has(choice.group)
      ? { description: t(`catalog.edit.tags.group.${choice.group}`) }
      : {}),
  });

  // The chip text carries the state: "Eid (archived)", "Unavailable tag".
  const value: SearchSelectOption[] = ids.map((id) => {
    const entry = known.get(id);
    return {
      value: id,
      label:
        entry === undefined
          ? t('catalog.edit.tags.unknown-chip')
          : entry.archived
            ? t('catalog.edit.tags.archived-chip', { name: entry.name })
            : entry.name,
    };
  });
  const archivedCount = ids.filter((id) => known.get(id)?.archived === true).length;
  const sentences = topicSentences(t, issues, ids, known, max);
  const help = [
    t('catalog.edit.tags.help'),
    ...(archivedCount > 0 ? [t('catalog.edit.tags.archived-help')] : []),
  ].join(' ');

  const suggestHref = `/tag-suggestions/new?${new URLSearchParams({
    product: productId,
    ...(term !== '' && results.length === 0 ? { label: term.slice(0, 40) } : {}),
  }).toString()}`;
  return (
    <div className="flex flex-col gap-2">
      <SearchSelect
        multiple
        label={t('catalog.edit.tags.label')}
        placeholder={t('catalog.edit.tags.placeholder')}
        help={help}
        error={sentences.length > 0 ? sentences.join(' ') : undefined}
        options={results.map(optionOf)}
        value={value}
        max={max}
        alwaysSearch
        loading={loading}
        loadError={loadError}
        onRetry={() => void search(lastQuery.current)}
        onSearch={(query) => void search(query)}
        labels={{
          search: t('catalog.edit.tags.labels.search'),
          noResults: t('catalog.edit.tags.labels.no-results'),
          loading: t('catalog.edit.tags.labels.loading'),
          retry: t('catalog.edit.tags.labels.retry'),
          remove: (name) => t('catalog.edit.tags.labels.remove', { name }),
          limitReached: (limit) => t('catalog.edit.tags.labels.limit-reached', { max: limit }),
          none: t('catalog.edit.tags.labels.none'),
        }}
        onChange={(next) => {
          for (const option of next) {
            const choice = results.find((item) => item.id === option.value);
            if (choice !== undefined && !known.has(choice.id)) {
              known.set(choice.id, { name: nameOfChoice(choice, defaultLocale), archived: false });
            }
          }
          onChange(next.map((option) => option.value));
        }}
      />
      <p className="text-sm">
        <a
          className="text-link underline"
          href={suggestHref}
          aria-label={t('catalog.edit.tags.suggest-aria')}
        >
          {t('catalog.edit.tags.suggest')}
        </a>
      </p>
      <p className="text-sm text-fg-muted">{t('catalog.edit.tags.suggest-help')}</p>
    </div>
  );
}
