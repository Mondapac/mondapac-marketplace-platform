'use client';

import { SearchSelect, type SearchSelectOption } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { pickLabel } from './draft-content.ts';
import type { TopicIssue } from './errors.ts';
import { API_TOPICS, TAG_PAGE, type TopicChoice, type TopicPage, type TopicRef } from './types.ts';

const GROUPS: ReadonlySet<string> = new Set(['occasion', 'cuisine', 'use']);

/** What the form knows about a tag it has seen: its name and whether it is archived. */
export interface KnownTag {
  readonly name: string;
  readonly archived: boolean;
}
export type KnownTags = Map<string, KnownTag>;

const nameOfChoice = (choice: TopicChoice, locale: string): string =>
  pickLabel(choice.names, locale, choice.slug);

/**
 * The tags the page has seen, by id: those the product read names (always up to date) and those
 * the admin picked in this session. Both the field and the banner name a tag from here.
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
    if (issue.code === 'too-many') return t('tags.too-many', { max });
    const entry = issue.index === null ? undefined : known.get(ids[issue.index] ?? '');
    if (entry === undefined) return t('tags.unknown-problem');
    return t(`tags.${issue.code}-problem`, { name: entry.name });
  });
}

/** The chip text carries the state: "Eid (archived)", "Unavailable tag". */
function chipLabel(t: Translate, entry: KnownTag | undefined): string {
  if (entry === undefined) return t('tags.unknown-chip');
  return entry.archived ? t('tags.archived-chip', { name: entry.name }) : entry.name;
}

/**
 * The admin's "Tags" field: a searchable multiple choice over the active tags of the Market
 * (`GET catalog/admin/topics?status=active`, server search). Saved tags are chips from the product
 * read. Without `catalog.topic.read` the field is a plain list of the saved tags and cannot change
 * them (a disabled select would be drawn too faint), and the form sends the tags back unchanged.
 */
export function TagField({
  ids,
  known,
  defaultLocale,
  issues,
  max,
  canRead,
  onChange,
}: {
  readonly ids: readonly string[];
  readonly known: KnownTags;
  readonly defaultLocale: string;
  /** The freeze refusals about tags, told as one sentence each next to the control. */
  readonly issues: readonly TopicIssue[];
  readonly max: number;
  readonly canRead: boolean;
  readonly onChange: (ids: string[]) => void;
}) {
  const t = useTranslations('catalog.productForm');
  const labelId = useId();
  const [results, setResults] = useState<readonly TopicChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const sequence = useRef(0);
  const lastQuery = useRef('');
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
      const mine = ++sequence.current;
      setLoading(true);
      setLoadError(undefined);
      const text = query.trim();
      const params = new URLSearchParams({ status: 'active', limit: String(TAG_PAGE) });
      if (text !== '') params.set('search', text);
      const result = await callApi<TopicPage>('GET', `${API_TOPICS}?${params.toString()}`);
      // A later search, or a closed page, has taken over.
      if (mine !== sequence.current || !mounted.current) return;
      setLoading(false);
      if (result.ok) {
        setResults(result.body.items);
        return;
      }
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setLoadError(
        t(result.failure.code === 'request.throttled' ? 'tags.load-throttled' : 'tags.load-error'),
      );
    },
    [t],
  );

  const archivedCount = ids.filter((id) => known.get(id)?.archived === true).length;
  const sentences = topicSentences(t, issues, ids, known, max);
  const archivedHelp = archivedCount > 0 ? ` ${t('tags.archived-help')}` : '';

  if (!canRead) {
    return (
      <div className="flex flex-col gap-1.5">
        <p id={labelId} className="text-sm font-medium text-fg">
          {t('tags.label')}
        </p>
        {ids.length === 0 ? (
          <p className="text-sm text-fg">{t('tags.none')}</p>
        ) : (
          <ul aria-labelledby={labelId} className="flex flex-wrap gap-1.5 text-sm text-fg">
            {ids.map((id) => (
              <li key={id} className="max-w-full break-words rounded-md bg-muted px-2 py-1">
                {chipLabel(t, known.get(id))}
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-fg-muted">{`${t('tags.readonly')}${archivedHelp}`}</p>
      </div>
    );
  }

  const optionOf = (choice: TopicChoice): SearchSelectOption => ({
    value: choice.id,
    label: nameOfChoice(choice, defaultLocale),
    ...(GROUPS.has(choice.group) ? { description: t(`tags.group.${choice.group}`) } : {}),
  });
  const value: SearchSelectOption[] = ids.map((id) => ({
    value: id,
    label: chipLabel(t, known.get(id)),
  }));

  return (
    <SearchSelect
      multiple
      label={t('tags.label')}
      placeholder={t('tags.placeholder')}
      help={`${t('tags.help', { max })}${archivedHelp}`}
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
        search: t('tags.labels.search'),
        noResults: t('tags.labels.no-results'),
        loading: t('tags.labels.loading'),
        retry: t('tags.labels.retry'),
        remove: (name) => t('tags.labels.remove', { name }),
        limitReached: (limit) => t('tags.labels.limit-reached', { max: limit }),
        none: t('tags.labels.none'),
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
  );
}
